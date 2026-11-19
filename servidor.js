'use strict';
/*
  Servidor da Loja com Roleta (Pix automático pelo Asaas + comprovante no WhatsApp)
  Precisa do Node 18 ou mais novo. Não usa nenhuma biblioteca externa.
  Coloque este arquivo e o index.html na mesma pasta e rode:   node servidor.js

  Única variável obrigatória:
    ADMIN_SENHA   senha do administrador (mínimo 6 caracteres). Abre o painel ⚙️.

  O resto (chave do Asaas, chave Pix, WhatsApp) você configura no painel ⚙️ da própria página.
  Variáveis opcionais:
    PORT          porta (padrão 3000)
    EXPIRA_MIN    minutos de validade de cada QR Code Pix (padrão 10)
    CORS_ORIGEM   só se a página ficar em outro endereço (ex.: https://minhaloja.com.br). Padrão: qualquer um
    TRUST_PROXY   "1" quando o servidor roda atrás de proxy (Render, Railway, Nginx...)
    DADOS         onde guardar os dados (padrão: dados.json ao lado deste arquivo)
    ASAAS_API_KEY, ASAAS_AMBIENTE, PIX_CHAVE   alternativa ao painel para o Asaas
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_SENHA = process.env.ADMIN_SENHA || '';
const ORIGEM = process.env.CORS_ORIGEM || '*';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const EXPIRA_SEG = Math.max(2, Number(process.env.EXPIRA_MIN) || 10) * 60;
const ARQUIVO = process.env.DADOS || path.join(__dirname, 'dados.json');
const PAGINA = path.join(__dirname, 'index.html');

if (ADMIN_SENHA.length < 6) {
  console.error('Defina a variável ADMIN_SENHA com pelo menos 6 caracteres. Exemplo: ADMIN_SENHA=minhasenha node servidor.js');
  process.exit(1);
}

/* ---------- dados ---------- */
const clone = (o) => JSON.parse(JSON.stringify(o));
const PADRAO = {
  loja: 'Minha Loja',
  logo: '',
  zapDono: '',
  produtos: [],
  premios: ['Brinde surpresa', 'Desconto de 10%', 'Cashback de R$ 5,00', 'Prêmio especial', 'Desconto de 5%', 'Brinde da casa'],
  roleta: { modo: 'livre', valor: 5, horas: 24 }
};
let dados = {
  config: clone(PADRAO),
  seg: { asaasKey: '', ambiente: '', pixChave: '', webhookToken: '', wProvedor: '', wUrl: '', wInstancia: '', wToken: '' },
  pedidos: {}, premios: {}, livres: {}, seq: 0
};
try {
  const l = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  if (l && typeof l === 'object') {
    dados.config = Object.assign(clone(PADRAO), l.config || {});
    dados.config.roleta = Object.assign({}, PADRAO.roleta, (l.config || {}).roleta || {});
    dados.seg = Object.assign(dados.seg, l.seg || {});
    for (const k of ['pedidos', 'premios', 'livres']) if (l[k] && typeof l[k] === 'object') dados[k] = l[k];
    dados.seq = Number(l.seq) || 0;
  }
} catch (e) { /* primeira execução */ }
if (!dados.seg.webhookToken) dados.seg.webhookToken = crypto.randomBytes(18).toString('hex');

function salvar() {
  const tmp = ARQUIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dados));
  fs.renameSync(tmp, ARQUIVO);
}
salvar();
function limpar() {
  const agora = Date.now(), dia = 86400000;
  for (const id of Object.keys(dados.pedidos)) {
    const p = dados.pedidos[id];
    if ((!p.pago && agora - p.criada > 2 * dia) || agora - p.criada > 400 * dia) delete dados.pedidos[id];
  }
  for (const c of Object.keys(dados.premios)) if (agora - dados.premios[c].criada > 400 * dia) delete dados.premios[c];
  for (const d of Object.keys(dados.livres)) if (agora - dados.livres[d] > 30 * dia) delete dados.livres[d];
}

const asaasKey = () => dados.seg.asaasKey || process.env.ASAAS_API_KEY || '';
const ambiente = () => String(dados.seg.ambiente || process.env.ASAAS_AMBIENTE || 'sandbox').toLowerCase();
const pixChave = () => dados.seg.pixChave || process.env.PIX_CHAVE || '';
const asaasBase = () => String(process.env.ASAAS_URL ||
  (ambiente() === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3')).replace(/\/+$/, '');
const pagamentoPronto = () => !!(asaasKey() && pixChave());

/* ---------- utilidades ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const adminOk = (req) => crypto.timingSafeEqual(sha(req.headers['x-admin-senha'] || ''), sha(ADMIN_SENHA));
const igual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const falhas = new Map();
const criacoes = new Map();
function ipDe(req) {
  const xf = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return xf || req.socket.remoteAddress || '?';
}
function bloqueado(ip) { const f = falhas.get(ip); return !!(f && f.n >= 10 && Date.now() < f.ate); }
function registrarFalha(ip) {
  const f = falhas.get(ip);
  if (!f || Date.now() > f.ate) falhas.set(ip, { n: 1, ate: Date.now() + 600000 }); else f.n++;
}
function podeCriar(ip) {
  const agora = Date.now();
  const lista = (criacoes.get(ip) || []).filter((t) => agora - t < 600000);
  if (lista.length >= 15) { criacoes.set(ip, lista); return false; }
  lista.push(agora); criacoes.set(ip, lista);
  return true;
}
const brl = (v) => {
  const [i, d] = Number(v).toFixed(2).split('.');
  return 'R$ ' + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d;
};
const dataHora = (ts) => new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const num4 = (n) => String(n).padStart(4, '0');
function normZap(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11) d = '55' + d;
  return d.length >= 12 && d.length <= 15 ? d : null;
}
const fmtZap = (d) => (d.startsWith('55') && d.length >= 12)
  ? '+55 (' + d.slice(2, 4) + ') ' + d.slice(4, d.length - 4) + '-' + d.slice(-4) : '+' + d;

/* ---------- validação ---------- */
function validarConfig(b) {
  if (!b || typeof b !== 'object') return { erro: 'Configuração inválida.' };
  const loja = typeof b.loja === 'string' ? b.loja.trim() : '';
  if (!loja || loja.length > 40) return { erro: 'Nome da loja inválido (até 40 letras).' };
  let logo = '';
  if (typeof b.logo === 'string' && b.logo) {
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(b.logo) || b.logo.length > 250000) return { erro: 'Logo inválida ou grande demais.' };
    logo = b.logo;
  }
  const zapDono = normZap(b.zapDono);
  if (zapDono === null) return { erro: 'WhatsApp do dono inválido. Use DDD + número, por exemplo (27) 99999-9999.' };

  if (!Array.isArray(b.produtos) || b.produtos.length > 60) return { erro: 'Cadastre no máximo 60 produtos.' };
  const ids = new Set(), produtos = [];
  for (const p of b.produtos) {
    if (!p || typeof p !== 'object') return { erro: 'Produto inválido.' };
    const nome = String(p.nome || '').trim();
    const preco = Math.round(Number(p.preco) * 100) / 100;
    if (!nome || nome.length > 60) return { erro: 'Todo produto precisa de nome (até 60 letras).' };
    if (!isFinite(preco) || preco < 0.01 || preco > 100000) return { erro: 'Preço inválido no produto "' + nome + '".' };
    const desc = String(p.desc || '').trim().slice(0, 200);
    let foto = '';
    if (typeof p.foto === 'string' && p.foto) {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.foto) || p.foto.length > 120000) return { erro: 'Foto grande demais no produto "' + nome + '".' };
      foto = p.foto;
    }
    let id = typeof p.id === 'string' && /^[\w-]{1,24}$/.test(p.id) ? p.id : '';
    while (!id || ids.has(id)) id = crypto.randomBytes(4).toString('hex');
    ids.add(id);
    produtos.push({ id, nome, preco, desc, foto, ativo: p.ativo !== false });
  }

  if (!Array.isArray(b.premios)) return { erro: 'Prêmios inválidos.' };
  const premios = b.premios.map((p) => String(p).trim()).filter(Boolean);
  if (premios.length < 2 || premios.length > 12 || premios.some((p) => p.length > 40)) return { erro: 'Use de 2 a 12 prêmios com até 40 letras.' };

  const r = b.roleta || {};
  const modo = ['livre', 'compra', 'pago'].includes(r.modo) ? r.modo : null;
  if (!modo) return { erro: 'Modo da roleta inválido.' };
  const valor = Math.round(Number(r.valor) * 100) / 100;
  if (!isFinite(valor) || valor < 0.01 || valor > 10000) return { erro: 'Valor do giro inválido.' };
  const horas = Math.round(Number(r.horas));
  if (!isFinite(horas) || horas < 1 || horas > 720) return { erro: 'Intervalo entre giros inválido (1 a 720 horas).' };
  return { config: { loja, logo, zapDono, produtos, premios, roleta: { modo, valor, horas } } };
}
const publica = () => {
  const c = dados.config;
  return {
    loja: c.loja, logo: c.logo || '', zapDono: c.zapDono || '',
    produtos: c.produtos.filter((p) => p.ativo), premios: c.premios, roleta: c.roleta,
    pagamentoPronto: pagamentoPronto()
  };
};

/* ---------- Asaas ---------- */
async function asaas(metodo, caminho, corpo) {
  const r = await fetch(asaasBase() + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'access_token': asaasKey(), 'User-Agent': 'loja-roleta' },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* sem corpo */ }
  if (!r.ok) {
    const msg = j && j.errors && j.errors[0] && j.errors[0].description;
    throw new Error('Asaas ' + r.status + (msg ? ': ' + msg : ''));
  }
  return j;
}
const ultimaChecagem = new Map();
async function verificarPago(p) {
  if (p.pago) return true;
  const agora = Date.now();
  if (agora - (ultimaChecagem.get(p.id) || 0) < 3000) return false;
  ultimaChecagem.set(p.id, agora);
  const r = await asaas('GET', '/payments?pixQrCodeId=' + encodeURIComponent(p.id) + '&limit=10');
  const lista = r && Array.isArray(r.data) ? r.data : [];
  if (lista.some((x) => ['RECEIVED', 'CONFIRMED'].includes(x.status) && Number(x.value) + 0.001 >= p.total)) marcarPago(p);
  return p.pago;
}

/* ---------- pedido pago: roleta e comprovantes ---------- */
function marcarPago(p) {
  if (p.pago) return;
  p.pago = true; p.pagoEm = Date.now();
  const modo = dados.config.roleta.modo;
  if (p.tipo === 'giro' || (p.tipo === 'compra' && modo === 'compra')) p.giro = { liberado: true, usado: false, codigo: null };
  salvar();
  notificar(p).catch((e) => console.error('notificar', e.message));
}
function linhasItens(p) {
  return p.itens.map((i) => i.qtd + 'x ' + i.nome + ' — ' + brl(i.preco * i.qtd)).join('\n');
}
function msgCliente(p) {
  return '✅ *Comprovante de pagamento*\n*' + dados.config.loja + '*\nPedido #' + num4(p.numero) + ' · ' + dataHora(p.pagoEm) +
    '\n\n' + linhasItens(p) + '\n\n*Total: ' + brl(p.total) + '* (Pix)\n\nObrigado, ' + p.cliente.nome.split(' ')[0] + '!';
}
function msgDono(p) {
  let t = '🛒 *Novo pedido pago* #' + num4(p.numero) + '\n' + dataHora(p.pagoEm) +
    '\n\n*Cliente:* ' + p.cliente.nome + '\n*WhatsApp:* ' + fmtZap(p.cliente.whats) + '\nhttps://wa.me/' + p.cliente.whats;
  if (p.cliente.email) t += '\n*E-mail:* ' + p.cliente.email;
  if (p.cliente.obs) t += '\n*Endereço/obs.:* ' + p.cliente.obs;
  return t + '\n\n' + linhasItens(p) + '\n\n*Total: ' + brl(p.total) + '*';
}
async function enviarZap(numero, texto) {
  const s = dados.seg;
  if (!s.wProvedor) return { ok: false, motivo: 'WhatsApp automático não configurado' };
  let url, headers = { 'Content-Type': 'application/json' }, corpo;
  if (s.wProvedor === 'zapi') {
    url = String(s.wUrl).replace(/\/+$/, '') + '/send-text';
    if (s.wToken) headers['Client-Token'] = s.wToken;
    corpo = { phone: numero, message: texto };
  } else if (s.wProvedor === 'evolution') {
    url = String(s.wUrl).replace(/\/+$/, '') + '/message/sendText/' + encodeURIComponent(s.wInstancia);
    headers.apikey = s.wToken;
    corpo = { number: numero, text: texto };
  } else return { ok: false, motivo: 'Provedor desconhecido' };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(corpo), signal: ctl.signal });
    if (!r.ok) return { ok: false, motivo: 'HTTP ' + r.status };
    return { ok: true };
  } catch (e) { return { ok: false, motivo: e.name === 'AbortError' ? 'tempo esgotado' : e.message }; }
  finally { clearTimeout(t); }
}
async function tentarEnviar(numero, texto) {
  if (!dados.seg.wProvedor) return 'sem provedor';
  let ultimo = '';
  for (const espera of [0, 1500, 6000]) {
    if (espera) await new Promise((r) => setTimeout(r, espera));
    const r = await enviarZap(numero, texto);
    if (r.ok) return 'ok';
    ultimo = r.motivo;
  }
  return 'erro: ' + ultimo;
}
async function notificar(p) {
  if (p.notif && p.notif.iniciado) return;
  p.notif = { iniciado: true, cliente: 'enviando', dono: 'enviando' };
  salvar();
  p.notif.cliente = await tentarEnviar(p.cliente.whats, msgCliente(p));
  const dono = dados.config.zapDono;
  p.notif.dono = dono ? await tentarEnviar(dono, msgDono(p)) : 'sem número do dono';
  salvar();
}

/* ---------- roleta ---------- */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function novoCodigo() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ALFABETO[crypto.randomInt(ALFABETO.length)];
    if (!dados.premios[c]) return c;
  }
}
function sortear(origem, ref) {
  const premios = dados.config.premios.slice();
  const indice = crypto.randomInt(premios.length);
  const codigo = novoCodigo();
  dados.premios[codigo] = { premio: premios[indice], premios, indice, origem, ref, criada: Date.now(), entregue: false };
  return { indice, premio: premios[indice], premios, codigo };
}
const resultadoDe = (codigo) => { const r = dados.premios[codigo]; return { indice: r.indice, premio: r.premio, premios: r.premios, codigo }; };

/* ---------- HTTP ---------- */
function responder(res, codigo, obj) {
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ORIGEM,
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-senha',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > 6000000) { falha(new Error('grande')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      try { ok(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); } catch (e) { falha(new Error('json')); }
    });
    req.on('error', falha);
  });
}
function exigirAdmin(req, res) {
  const ip = ipDe(req);
  if (bloqueado(ip)) { responder(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' }); return false; }
  if (!adminOk(req)) { registrarFalha(ip); responder(res, 401, { erro: 'Senha do administrador incorreta.' }); return false; }
  return true;
}
function statusDe(p) {
  const expirado = !p.pago && Date.now() > p.criada + (EXPIRA_SEG + 120) * 1000;
  const o = { pago: p.pago, expirado, numero: p.numero };
  if (p.pago) {
    o.comprovante = { numero: p.numero, itens: p.itens, total: p.total, pagoEm: p.pagoEm, tipo: p.tipo, loja: dados.config.loja };
    o.giro = p.giro ? { liberado: !!p.giro.liberado, usado: !!p.giro.usado } : null;
    o.notif = p.notif ? { cliente: p.notif.cliente || '', dono: p.notif.dono || '' } : null;
  }
  return o;
}
function resumoPedido(p) {
  return { id: p.id, numero: p.numero, tipo: p.tipo, total: p.total, cliente: p.cliente.nome, whats: p.cliente.whats, pago: p.pago, criada: p.criada, notif: p.notif || null };
}

const servidor = http.createServer(async (req, res) => {
  const ip = ipDe(req);
  try {
    if (req.method === 'OPTIONS') return responder(res, 204, {});
    const url = new URL(req.url, 'http://localhost');
    const rota = url.pathname.replace(/\/+$/, '') || '/';
    let m;

    if (req.method === 'GET' && (rota === '/' || rota === '/index.html')) {
      let html;
      try { html = fs.readFileSync(PAGINA); } catch (e) { return responder(res, 500, { erro: 'index.html não encontrado ao lado do servidor.' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }

    /* ----- público ----- */
    if (req.method === 'GET' && rota === '/api/config') return responder(res, 200, publica());

    if (req.method === 'POST' && rota === '/api/pedido') {
      if (!pagamentoPronto()) return responder(res, 503, { erro: 'O pagamento ainda não foi configurado pela loja.' });
      if (!podeCriar(ip)) return responder(res, 429, { erro: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.' });
      const b = await lerCorpo(req);
      const nome = String((b.cliente && b.cliente.nome) || '').trim();
      const whats = normZap(b.cliente && b.cliente.whats);
      if (nome.length < 2 || nome.length > 60) return responder(res, 400, { erro: 'Informe seu nome.' });
      if (!whats) return responder(res, 400, { erro: 'Informe um WhatsApp válido com DDD.' });
      const email = String((b.cliente && b.cliente.email) || '').trim().slice(0, 80);
      if (email && !/^\S+@\S+\.\S+$/.test(email)) return responder(res, 400, { erro: 'E-mail inválido.' });
      const obs = String((b.cliente && b.cliente.obs) || '').trim().slice(0, 200);
      const tipo = b.tipo === 'giro' ? 'giro' : 'compra';
      let itens = [], total = 0;
      if (tipo === 'giro') {
        if (dados.config.roleta.modo !== 'pago') return responder(res, 400, { erro: 'A roleta não é paga nesta loja.' });
        total = dados.config.roleta.valor;
        itens = [{ id: 'giro', nome: 'Giro da roleta', preco: total, qtd: 1 }];
      } else {
        if (!Array.isArray(b.itens) || !b.itens.length || b.itens.length > 30) return responder(res, 400, { erro: 'Carrinho vazio.' });
        for (const it of b.itens) {
          const prod = dados.config.produtos.find((p) => p.id === it.id && p.ativo);
          const qtd = Math.floor(Number(it.qtd));
          if (!prod) return responder(res, 400, { erro: 'Um dos produtos não está mais disponível. Atualize a página.' });
          if (!(qtd >= 1 && qtd <= 20)) return responder(res, 400, { erro: 'Quantidade inválida.' });
          itens.push({ id: prod.id, nome: prod.nome, preco: prod.preco, qtd });
          total += prod.preco * qtd;
        }
        total = Math.round(total * 100) / 100;
      }
      if (total < 0.01) return responder(res, 400, { erro: 'Valor inválido.' });
      const r = await asaas('POST', '/pix/qrCodes/static', {
        addressKey: pixChave(), description: 'Pedido ' + dados.config.loja.slice(0, 40), value: total,
        format: 'ALL', expirationSeconds: EXPIRA_SEG, allowsMultiplePayments: false
      });
      let payload = String((r && r.payload) || '');
      if (!/^0002/.test(payload)) {
        try { const d = Buffer.from(payload, 'base64').toString('utf8'); if (/^0002/.test(d)) payload = d; } catch (e) { /* mantém */ }
      }
      if (!r || !r.id || !/^0002/.test(payload)) throw new Error('Resposta inesperada do Asaas.');
      limpar();
      const numero = ++dados.seq;
      dados.pedidos[r.id] = { id: r.id, numero, tipo, itens, total, cliente: { nome, whats, email, obs }, criada: Date.now(), pago: false, giro: null, notif: null };
      salvar();
      return responder(res, 200, { id: r.id, numero, payload, total, expiraEm: Date.now() + EXPIRA_SEG * 1000, itens });
    }

    if (req.method === 'GET' && (m = rota.match(/^\/api\/pedido\/([\w-]+)\/status$/))) {
      const p = dados.pedidos[m[1]];
      if (!p) return responder(res, 404, { erro: 'Pedido não encontrado.' });
      if (!p.pago && pagamentoPronto()) await verificarPago(p);
      return responder(res, 200, statusDe(p));
    }

    if (req.method === 'POST' && (m = rota.match(/^\/api\/girar\/([\w-]+)$/))) {
      const p = dados.pedidos[m[1]];
      if (!p) return responder(res, 404, { erro: 'Pedido não encontrado.' });
      if (!p.pago && pagamentoPronto()) await verificarPago(p);
      if (!p.pago) return responder(res, 402, { erro: 'Pagamento ainda não confirmado.' });
      if (!p.giro || !p.giro.liberado) return responder(res, 403, { erro: 'Este pedido não dá direito a girar a roleta.' });
      if (!p.giro.usado) {
        const s = sortear(p.tipo === 'giro' ? 'pago' : 'compra', p.id);
        p.giro.usado = true; p.giro.codigo = s.codigo; salvar();
      }
      return responder(res, 200, resultadoDe(p.giro.codigo));
    }

    if (req.method === 'POST' && rota === '/api/girar-livre') {
      if (dados.config.roleta.modo !== 'livre') return responder(res, 400, { erro: 'A roleta livre não está ativa.' });
      const b = await lerCorpo(req);
      const disp = String(b.dispositivo || '');
      if (!/^[\w-]{8,64}$/.test(disp)) return responder(res, 400, { erro: 'Dispositivo inválido.' });
      const espera = dados.config.roleta.horas * 3600000, ultimo = dados.livres[disp] || 0;
      if (Date.now() - ultimo < espera) return responder(res, 429, { erro: 'Você já girou a roleta. Volte mais tarde.', proximo: ultimo + espera });
      dados.livres[disp] = Date.now();
      const s = sortear('livre', disp); limpar(); salvar();
      return responder(res, 200, Object.assign({ proximo: dados.livres[disp] + espera }, s));
    }

    if (req.method === 'POST' && rota === '/api/webhook/asaas') {
      const token = req.headers['asaas-access-token'] || '';
      if (!igual(token, dados.seg.webhookToken)) return responder(res, 401, { erro: 'Token inválido.' });
      const b = await lerCorpo(req);
      const pg = b && b.payment;
      if (b && ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(b.event) && pg && pg.pixQrCodeId) {
        const p = dados.pedidos[pg.pixQrCodeId];
        if (p && !p.pago) {
          if (Number(pg.value) + 0.001 >= p.total) marcarPago(p);
          else if (pagamentoPronto()) await verificarPago(p).catch(() => {});
        }
      }
      return responder(res, 200, { ok: true });
    }

    /* ----- administrador ----- */
    if (req.method === 'GET' && rota === '/api/admin/ping') {
      if (!exigirAdmin(req, res)) return;
      return responder(res, 200, { ok: true });
    }
    if (req.method === 'GET' && rota === '/api/admin/dados') {
      if (!exigirAdmin(req, res)) return;
      const s = dados.seg, chave = asaasKey();
      const pedidos = Object.values(dados.pedidos).sort((a, b) => b.criada - a.criada).slice(0, 25).map(resumoPedido);
      return responder(res, 200, {
        config: dados.config,
        pagamento: {
          temChave: !!chave, chaveFim: chave ? chave.slice(-4) : '', ambiente: ambiente(), pixChave: pixChave(),
          webhookToken: s.webhookToken, wProvedor: s.wProvedor, wUrl: s.wUrl, wInstancia: s.wInstancia, temWToken: !!s.wToken,
          pronto: pagamentoPronto()
        },
        pedidos
      });
    }
    if (req.method === 'POST' && rota === '/api/config') {
      if (!exigirAdmin(req, res)) return;
      const v = validarConfig(await lerCorpo(req));
      if (v.erro) return responder(res, 400, { erro: v.erro });
      dados.config = v.config; salvar();
      return responder(res, 200, { ok: true, config: publica() });
    }
    if (req.method === 'POST' && rota === '/api/admin/pagamento') {
      if (!exigirAdmin(req, res)) return;
      const b = await lerCorpo(req), s = dados.seg;
      const amb = b.ambiente === 'producao' ? 'producao' : 'sandbox';
      const chavePix = String(b.pixChave || '').trim();
      const prov = ['', 'zapi', 'evolution'].includes(b.wProvedor) ? b.wProvedor : null;
      if (prov === null) return responder(res, 400, { erro: 'Provedor de WhatsApp inválido.' });
      const wUrl = String(b.wUrl || '').trim().replace(/\/+$/, '');
      const wInst = String(b.wInstancia || '').trim();
      if (chavePix.length > 77) return responder(res, 400, { erro: 'Chave Pix inválida.' });
      if (prov && !/^https?:\/\/\S+$/.test(wUrl)) return responder(res, 400, { erro: 'Informe o endereço do provedor de WhatsApp, começando com https://' });
      if (prov === 'evolution' && !wInst) return responder(res, 400, { erro: 'Informe o nome da instância do Evolution.' });
      if (typeof b.asaasKey === 'string' && b.asaasKey.trim()) {
        const k = b.asaasKey.trim();
        if (k.length < 20 || k.length > 300 || /\s/.test(k)) return responder(res, 400, { erro: 'Chave de API do Asaas inválida.' });
        s.asaasKey = k;
      }
      if (typeof b.wToken === 'string' && b.wToken.trim()) s.wToken = b.wToken.trim().slice(0, 300);
      s.ambiente = amb; s.pixChave = chavePix; s.wProvedor = prov; s.wUrl = wUrl; s.wInstancia = wInst;
      salvar();
      return responder(res, 200, { ok: true, pronto: pagamentoPronto() });
    }
    if (req.method === 'POST' && rota === '/api/admin/teste-whats') {
      if (!exigirAdmin(req, res)) return;
      const b = await lerCorpo(req);
      const alvo = normZap(b.numero || dados.config.zapDono);
      if (!alvo) return responder(res, 400, { erro: 'Informe o WhatsApp do dono e salve antes de testar.' });
      const r = await enviarZap(alvo, '✅ Teste da loja *' + dados.config.loja + '*: o WhatsApp automático está funcionando.');
      return responder(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { erro: 'Falha ao enviar: ' + r.motivo });
    }
    if (req.method === 'POST' && (m = rota.match(/^\/api\/admin\/pedido\/([\w-]+)\/reenviar$/))) {
      if (!exigirAdmin(req, res)) return;
      const p = dados.pedidos[m[1]];
      if (!p || !p.pago) return responder(res, 404, { erro: 'Pedido pago não encontrado.' });
      p.notif = null; salvar();
      await notificar(p);
      return responder(res, 200, { notif: p.notif });
    }
    if ((m = rota.match(/^\/api\/premio\/([\w-]+)(\/entregar)?$/))) {
      if (!exigirAdmin(req, res)) return;
      const cod = m[1].toUpperCase(), rec = dados.premios[cod];
      if (!rec) return responder(res, 404, { erro: 'Código não encontrado.' });
      if (req.method === 'POST' && m[2]) {
        if (rec.entregue) return responder(res, 409, { erro: 'Este prêmio já foi entregue.' });
        rec.entregue = true; rec.entregueEm = Date.now(); salvar();
      } else if (req.method !== 'GET' || m[2]) return responder(res, 405, { erro: 'Método não permitido.' });
      return responder(res, 200, { premio: rec.premio, codigo: cod, criada: rec.criada, origem: rec.origem, entregue: !!rec.entregue });
    }

    return responder(res, 404, { erro: 'Rota não encontrada.' });
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e.message);
    if (e.message === 'grande') return responder(res, 413, { erro: 'Dados grandes demais.' });
    if (e.message === 'json') return responder(res, 400, { erro: 'Dados inválidos.' });
    return responder(res, 502, { erro: 'Não foi possível falar com o Asaas agora. Confira a chave e a chave Pix no painel.' });
  }
});

/* rede de segurança: confere pedidos pendentes mesmo se o cliente fechou a página */
setInterval(async () => {
  if (!pagamentoPronto()) return;
  const agora = Date.now();
  const pend = Object.values(dados.pedidos).filter((p) => !p.pago && agora - p.criada < (EXPIRA_SEG + 600) * 1000).slice(0, 10);
  for (const p of pend) { try { await verificarPago(p); } catch (e) { /* tenta no próximo ciclo */ } }
}, 20000).unref();

servidor.listen(PORT, () => console.log('Loja com roleta no ar: http://localhost:' + PORT));
