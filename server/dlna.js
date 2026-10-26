'use strict';
// Minimal DLNA / UPnP MediaServer so smart TVs, game consoles and apps such
// as VLC find the library on their own ("Media server" / "Sources" menu).
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { config } = require('./config');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const UUID = 'uuid:' + (() => {
  const h = crypto.createHash('md5').update('cineteca:' + os.hostname() + config.mediaRoot).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
})();
const TYPES = [
  'upnp:rootdevice',
  'urn:schemas-upnp-org:device:MediaServer:1',
  'urn:schemas-upnp-org:service:ContentDirectory:1',
  'urn:schemas-upnp-org:service:ConnectionManager:1',
];

const xmlEscape = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

const toInt = ip => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
function addressFor(remote) {
  const list = lanAddresses();
  const match = list.find(a => ((toInt(a.address) & toInt(a.netmask)) >>> 0) === ((toInt(remote) & toInt(a.netmask)) >>> 0));
  return (match || list[0] || { address: '127.0.0.1' }).address;
}

function descriptionXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device>
<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
<friendlyName>${xmlEscape(config.serverName)}</friendlyName>
<manufacturer>Cineteca</manufacturer>
<modelName>Cineteca</modelName>
<modelNumber>1</modelNumber>
<UDN>${UUID}</UDN>
<dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>
<serviceList>
<service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/dlna/cds.xml</SCPDURL><controlURL>/dlna/cds/control</controlURL><eventSubURL>/dlna/cds/event</eventSubURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><SCPDURL>/dlna/cms.xml</SCPDURL><controlURL>/dlna/cms/control</controlURL><eventSubURL>/dlna/cms/event</eventSubURL></service>
</serviceList>
</device>
</root>`;
}

const arg = (name, dir, rel) => `<argument><name>${name}</name><direction>${dir}</direction><relatedStateVariable>${rel}</relatedStateVariable></argument>`;
const action = (name, args) => `<action><name>${name}</name><argumentList>${args.join('')}</argumentList></action>`;
const scpd = (actions, vars) => `<?xml version="1.0" encoding="UTF-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<actionList>${actions.join('')}</actionList><serviceStateTable>${vars.map(([n, t, ev]) =>
  `<stateVariable sendEvents="${ev ? 'yes' : 'no'}"><name>${n}</name><dataType>${t}</dataType></stateVariable>`).join('')}</serviceStateTable></scpd>`;

const CDS_XML = scpd([
  action('Browse', [arg('ObjectID', 'in', 'A_ARG_TYPE_ObjectID'), arg('BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag'),
    arg('Filter', 'in', 'A_ARG_TYPE_Filter'), arg('StartingIndex', 'in', 'A_ARG_TYPE_Index'),
    arg('RequestedCount', 'in', 'A_ARG_TYPE_Count'), arg('SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria'),
    arg('Result', 'out', 'A_ARG_TYPE_Result'), arg('NumberReturned', 'out', 'A_ARG_TYPE_Count'),
    arg('TotalMatches', 'out', 'A_ARG_TYPE_Count'), arg('UpdateID', 'out', 'A_ARG_TYPE_UpdateID')]),
  action('GetSystemUpdateID', [arg('Id', 'out', 'SystemUpdateID')]),
  action('GetSearchCapabilities', [arg('SearchCaps', 'out', 'SearchCapabilities')]),
  action('GetSortCapabilities', [arg('SortCaps', 'out', 'SortCapabilities')]),
], [['A_ARG_TYPE_ObjectID', 'string'], ['A_ARG_TYPE_BrowseFlag', 'string'], ['A_ARG_TYPE_Filter', 'string'],
  ['A_ARG_TYPE_Index', 'ui4'], ['A_ARG_TYPE_Count', 'ui4'], ['A_ARG_TYPE_SortCriteria', 'string'],
  ['A_ARG_TYPE_Result', 'string'], ['A_ARG_TYPE_UpdateID', 'ui4'], ['SystemUpdateID', 'ui4', true],
  ['SearchCapabilities', 'string'], ['SortCapabilities', 'string']]);

const CMS_XML = scpd([
  action('GetProtocolInfo', [arg('Source', 'out', 'SourceProtocolInfo'), arg('Sink', 'out', 'SinkProtocolInfo')]),
  action('GetCurrentConnectionIDs', [arg('ConnectionIDs', 'out', 'CurrentConnectionIDs')]),
], [['SourceProtocolInfo', 'string', true], ['SinkProtocolInfo', 'string', true], ['CurrentConnectionIDs', 'string', true]]);

function soapEnvelope(actionName, service, values) {
  const body = Object.entries(values).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${actionName}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${actionName}Response></s:Body></s:Envelope>`;
}

const soapValue = (xml, tag) => (xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]*)</`)) || [])[1] || '';

// getTree() -> [{ id, title, children: [...] } | { id, title, size, mime, url }]
function createRouter(getTree, mediaUrl) {
  const router = express.Router();
  let updateId = 1;

  router.get('/description.xml', (req, res) => res.type('text/xml').send(descriptionXml()));
  router.get('/cds.xml', (req, res) => res.type('text/xml').send(CDS_XML));
  router.get('/cms.xml', (req, res) => res.type('text/xml').send(CMS_XML));
  router.all(['/cds/event', '/cms/event'], (req, res) => {
    res.set({ SID: 'uuid:' + crypto.randomUUID(), TIMEOUT: 'Second-1800' }).end();
  });

  router.post('/cms/control', express.text({ type: '*/*' }), (req, res) => {
    const act = (req.get('soapaction') || '').replace(/"/g, '').split('#')[1];
    const values = act === 'GetProtocolInfo'
      ? { Source: 'http-get:*:video/mp4:*,http-get:*:video/x-matroska:*,http-get:*:video/webm:*,http-get:*:video/x-msvideo:*,http-get:*:video/mpeg:*', Sink: '' }
      : { ConnectionIDs: '0' };
    res.type('text/xml; charset="utf-8"').send(soapEnvelope(act || 'GetProtocolInfo', 'ConnectionManager', values));
  });

  router.post('/cds/control', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const act = (req.get('soapaction') || '').replace(/"/g, '').split('#')[1];
    if (act === 'GetSystemUpdateID') return res.type('text/xml').send(soapEnvelope(act, 'ContentDirectory', { Id: updateId }));
    if (act === 'GetSearchCapabilities') return res.type('text/xml').send(soapEnvelope(act, 'ContentDirectory', { SearchCaps: '' }));
    if (act === 'GetSortCapabilities') return res.type('text/xml').send(soapEnvelope(act, 'ContentDirectory', { SortCaps: '' }));
    if (act !== 'Browse') return res.status(500).type('text/xml').send(soapEnvelope('Error', 'ContentDirectory', {}));

    const xml = req.body || '';
    const objectId = soapValue(xml, 'ObjectID') || '0';
    const flag = soapValue(xml, 'BrowseFlag');
    const startIndex = Number(soapValue(xml, 'StartingIndex')) || 0;
    const count = Number(soapValue(xml, 'RequestedCount')) || 0;
    const host = `http://${addressFor(req.socket.remoteAddress.replace(/^::ffff:/, ''))}:${config.port}`;

    const root = { id: '0', title: config.serverName, children: await getTree() };
    const index = new Map();
    const walk = (node, parent) => {
      index.set(node.id, { node, parent });
      (node.children || []).forEach(c => walk(c, node.id));
    };
    walk(root, '-1');
    const found = index.get(objectId) || index.get('0');

    const didl = (node, parent) => {
      if (node.children) {
        return `<container id="${xmlEscape(node.id)}" parentID="${xmlEscape(parent)}" restricted="1" childCount="${node.children.length}" searchable="0"><dc:title>${xmlEscape(node.title)}</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`;
      }
      const url = host + mediaUrl(node);
      const pinfo = `http-get:*:${node.mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`;
      const thumb = node.thumb ? `<upnp:albumArtURI>${xmlEscape(host + node.thumb)}</upnp:albumArtURI>` : '';
      return `<item id="${xmlEscape(node.id)}" parentID="${xmlEscape(parent)}" restricted="1"><dc:title>${xmlEscape(node.title)}</dc:title><upnp:class>object.item.videoItem</upnp:class>${thumb}<res protocolInfo="${pinfo}" size="${node.size}">${xmlEscape(url)}</res></item>`;
    };

    let entries;
    let total;
    if (flag === 'BrowseMetadata') {
      entries = [didl(found.node, found.parent)];
      total = 1;
    } else {
      const children = found.node.children || [];
      total = children.length;
      const slice = children.slice(startIndex, count ? startIndex + count : undefined);
      entries = slice.map(c => didl(c, found.node.id));
    }
    const result = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${entries.join('')}</DIDL-Lite>`;
    res.type('text/xml; charset="utf-8"').send(soapEnvelope('Browse', 'ContentDirectory', {
      Result: result, NumberReturned: entries.length, TotalMatches: total, UpdateID: updateId,
    }));
  });

  router.bump = () => { updateId++; };
  return router;
}

// SSDP: answer discovery requests and announce ourselves periodically.
function startSsdp() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const server = `${os.type()}/${os.release()} UPnP/1.0 Cineteca/1.0`;
  const location = ip => `http://${ip}:${config.port}/dlna/description.xml`;
  const usn = nt => (nt === UUID ? UUID : `${UUID}::${nt}`);

  const notify = (nts) => {
    for (const { address } of lanAddresses()) {
      for (const nt of [UUID, ...TYPES]) {
        const msg = [
          'NOTIFY * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, `NT: ${nt}`, `NTS: ${nts}`, `USN: ${usn(nt)}`,
          ...(nts === 'ssdp:alive' ? ['CACHE-CONTROL: max-age=1800', `LOCATION: ${location(address)}`, `SERVER: ${server}`] : []),
          '', ''].join('\r\n');
        try {
          socket.setMulticastInterface(address);
          socket.send(msg, SSDP_PORT, SSDP_ADDR);
        } catch { /* interface went away */ }
      }
    }
  };

  socket.on('message', (buf, rinfo) => {
    const text = buf.toString();
    if (!text.startsWith('M-SEARCH')) return;
    const st = (text.match(/^ST:\s*(.+)$/im) || [])[1]?.trim();
    if (!st) return;
    const targets = st === 'ssdp:all' ? [UUID, ...TYPES] : [UUID, ...TYPES].filter(t => t === st);
    const ip = addressFor(rinfo.address);
    for (const t of targets) {
      const msg = ['HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800', `DATE: ${new Date().toUTCString()}`, 'EXT:',
        `LOCATION: ${location(ip)}`, `SERVER: ${server}`, `ST: ${t}`, `USN: ${usn(t)}`, '', ''].join('\r\n');
      socket.send(msg, rinfo.port, rinfo.address);
    }
  });

  socket.on('error', err => console.warn('[dlna] SSDP disabled:', err.message));
  socket.bind(SSDP_PORT, () => {
    for (const { address } of lanAddresses()) {
      try { socket.addMembership(SSDP_ADDR, address); } catch { /* not multicast capable */ }
    }
    socket.setMulticastTTL(4);
    notify('ssdp:alive');
  });
  const timer = setInterval(() => notify('ssdp:alive'), 60000);

  return {
    stop() {
      clearInterval(timer);
      try { notify('ssdp:byebye'); socket.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { createRouter, startSsdp, lanAddresses };
