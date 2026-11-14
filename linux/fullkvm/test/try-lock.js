// Dev check (not shipped in any build's flow): types through the Full KVM service like the mesh does.
// node linux/fullkvm/test/try-lock.js KeyA,KeyB,...   (as the seat's user, while nothing else holds the socket)
const net = require('net');
const s = net.connect(process.env.TWINDESK_KVM_SOCK || '/run/twindesk/kvm.sock');
const keys = (process.argv[2] || 'KeyT,KeyW,KeyI,KeyN').split(',');
const send = (o) => s.write(JSON.stringify(o) + '\n');
let buf = '';
s.on('data', (d) => {
  buf += d;
  if (!buf.includes('"ready"')) return;
  buf = '';
  console.log('ready: injecting', keys.join(' '));
  send({ cmd: 'inject', ev: { t: 'k.mm', dx: 40, dy: 30 } });
  send({ cmd: 'inject', ev: { t: 'k.md', b: 0 } }); send({ cmd: 'inject', ev: { t: 'k.mu', b: 0 } });
  let i = 0;
  const next = () => {
    if (i >= keys.length) { send({ cmd: 'clipFiles', id: 9 }); setTimeout(() => s.end(), 600); return; }
    const code = keys[i++];
    send({ cmd: 'inject', ev: { t: 'k.kd', code } }); send({ cmd: 'inject', ev: { t: 'k.ku', code } });
    setTimeout(next, 250);
  };
  setTimeout(next, 1200);
});
s.on('data', (d) => { if (String(d).includes('"id":9')) console.log('refused as it should be:', String(d).trim()); });
s.on('error', (e) => console.log('error', e.message));
