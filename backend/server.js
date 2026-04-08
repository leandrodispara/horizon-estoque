const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI = 'https://horizon-estoque.onrender.com/auth/ml/callback';

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});

async function enviarEmailAdmin(assunto, html) {
  try {
    await mailer.sendMail({
      from: `"Horizon Estoque" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: assunto,
      html
    });
  } catch (err) { console.error('EMAIL ERROR:', err.message); }
}

async function getMLTokenCliente(cliente) {
  if (!cliente.ml_refresh_token) throw new Error('Cliente nao autorizou o ML ainda.');
  try {
    const res = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: cliente.ml_refresh_token
    });
    if (res.data.refresh_token) {
      await supabase.from('clientes').update({
        ml_access_token: res.data.access_token,
        ml_refresh_token: res.data.refresh_token
      }).eq('id', cliente.id);
    }
    return res.data.access_token;
  } catch (err) {
    console.error('ML TOKEN ERROR:', err.response?.data);
    throw new Error('Falha ao renovar token ML do cliente.');
  }
}

function extrairEAN(body) {
  const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];
  if (body.attributes) {
    for (const id of EAN_IDS) {
      const attr = body.attributes.find(a => a.id === id);
      if (attr?.values?.[0]?.name) return attr.values[0].name;
    }
  }
  if (body.variations && body.variations.length > 0) {
    for (const v of body.variations) {
      for (const id of EAN_IDS) {
        const a = (v.attributes || []).find(x => x.id === id) || (v.attribute_combinations || []).find(x => x.id === id);
        if (a?.values?.[0]?.name) return a.values[0].name;
      }
    }
  }
  return null;
}

async function authMiddleware(req, res, next) {
  const token = req.headers['x-access-token'];
  if (!token) return res.status(401).json({ error: 'Token nao fornecido' });
  const { data, error } = await supabase.from('clientes').select('*').eq('token', token).single();
  if (error || !data) return res.status(401).json({ error: 'Token invalido' });
  if (!data.ativo) return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com a Horizon Consultoria.' });
  req.cliente = data;
  next();
}

function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Nao autorizado' });
  next();
}

// OAUTH ML
app.get('/auth/ml/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Autorizacao negada</h2></body></html>');
  if (!code || !state) return res.status(400).send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Erro: parametros invalidos</h2></body></html>');
  let clienteId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    clienteId = decoded.clienteId;
  } catch { return res.status(400).send('<html><body>Estado invalido</body></html>'); }
  const { data: cliente } = await supabase.from('clientes').select('*').eq('id', clienteId).single();
  if (!cliente) return res.status(404).send('<html><body>Cliente nao encontrado</body></html>');
  try {
    const tokenRes = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: ML_REDIRECT_URI
    });
    await supabase.from('clientes').update({
      ml_access_token: tokenRes.data.access_token,
      ml_refresh_token: tokenRes.data.refresh_token,
      ml_user_id: String(tokenRes.data.user_id),
      ml_autorizado: true,
      ml_autorizado_em: new Date().toISOString()
    }).eq('id', clienteId);

    const agora = new Date().toLocaleString('pt-BR');
    enviarEmailAdmin(
      `[Horizon] ${cliente.nome_loja} autorizou o ML`,
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#1A3C6E">Nova autorizacao ML</h2>
        <p>A loja <strong>${cliente.nome_loja}</strong> autorizou o acesso ao Mercado Livre.</p>
        <table style="width:100%;margin-top:16px;font-size:13px;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#7A8EA8">Loja</td><td><strong>${cliente.nome_loja}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#7A8EA8">Token</td><td><code>${cliente.token}</code></td></tr>
          <tr><td style="padding:6px 0;color:#7A8EA8">ML User ID</td><td>${tokenRes.data.user_id}</td></tr>
          <tr><td style="padding:6px 0;color:#7A8EA8">Data/hora</td><td>${agora}</td></tr>
        </table>
        <p style="margin-top:20px;font-size:12px;color:#7A8EA8">Acesse o painel admin para sincronizar os anuncios.</p>
      </div>`
    );

    return res.send(`<html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;background:#FDF5F7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:white;border-radius:16px;padding:40px;text-align:center;max-width:400px}h2{color:#9E3A4F}</style></head><body><div class="box"><div style="font-size:48px">&#10003;</div><h2>Autorizado com sucesso!</h2><p>A loja <strong>${cliente.nome_loja}</strong> foi conectada ao Mercado Livre.</p><p style="margin-top:16px;color:#9B7F8A">Voce ja pode fechar esta janela.</p></div></body></html>`);
  } catch (err) {
    console.error('OAUTH ERROR:', err.response?.data);
    return res.status(500).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Erro ao autorizar</h2><pre>${JSON.stringify(err.response?.data)}</pre></body></html>`);
  }
});

// ROTAS CLIENTE
app.post('/auth', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token obrigatorio' });
  const { data, error } = await supabase.from('clientes')
    .select('id, nome_loja, token, ativo, dispositivos_max, estoque_minimo_alerta, ml_autorizado').eq('token', token).single();
  if (error || !data) return res.status(401).json({ error: 'Codigo de acesso invalido' });
  if (!data.ativo) return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com a Horizon Consultoria.' });
  res.json({ ok: true, loja: data.nome_loja, clienteId: data.id, estoqueMinimo: data.estoque_minimo_alerta || 3, mlAutorizado: data.ml_autorizado || false });
});

app.get('/anuncios', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('anuncios').select('*').eq('cliente_id', req.cliente.id).order('nome');
  if (error) return res.status(500).json({ error: 'Erro ao buscar anuncios' });
  res.json(data);
});

app.get('/produto/:ean', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('anuncios').select('*').eq('cliente_id', req.cliente.id).eq('ean', req.params.ean).single();
  if (error || !data) return res.status(404).json({ error: 'Produto nao encontrado' });
  res.json(data);
});

app.put('/baixa', authMiddleware, async (req, res) => {
  const { ean, quantidade } = req.body;
  if (!ean || !quantidade || quantidade < 1) return res.status(400).json({ error: 'EAN e quantidade sao obrigatorios' });
  const { data: produto } = await supabase.from('anuncios').select('*').eq('cliente_id', req.cliente.id).eq('ean', ean).single();
  if (!produto) {
    await supabase.from('eans_desconhecidos').upsert({ cliente_id: req.cliente.id, ean, quantidade_tentativas: 1, atualizado_em: new Date().toISOString() }, { onConflict: 'cliente_id,ean', ignoreDuplicates: false }).catch(() => {});
    return res.status(404).json({ error: 'Produto nao encontrado', tipo: 'ean_desconhecido' });
  }
  if (produto.estoque < quantidade) return res.status(400).json({ error: `Estoque insuficiente. Disponivel: ${produto.estoque}` });
  const novoEstoque = produto.estoque - quantidade;
  try {
    const mlToken = await getMLTokenCliente(req.cliente);
    await axios.put(`https://api.mercadolibre.com/items/${produto.ml_item_id}`, { available_quantity: novoEstoque }, { headers: { Authorization: `Bearer ${mlToken}` } });
  } catch (err) {
    await supabase.from('pendentes').insert({ cliente_id: req.cliente.id, ean: produto.ean, produto_nome: produto.nome, variacao_nome: produto.variacao_nome, quantidade, motivo_falha: err.message || 'Erro de conexao', tentativas: 1, resolvido: false, criado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() });
    return res.status(503).json({ error: 'Falha na conexao com ML. Baixa salva na fila.', tipo: 'pendente' });
  }
  await supabase.from('anuncios').update({ estoque: novoEstoque, atualizado_em: new Date().toISOString() }).eq('id', produto.id);
  const { data: baixaInserida } = await supabase.from('baixas').insert({ cliente_id: req.cliente.id, anuncio_id: produto.id, produto_nome: produto.nome, ean: produto.ean, quantidade, estoque_antes: produto.estoque, estoque_depois: novoEstoque, criado_em: new Date().toISOString() }).select().single();
  res.json({ ok: true, baixa_id: baixaInserida?.id, produto: produto.nome, variacao: produto.variacao_nome, estoque_anterior: produto.estoque, estoque_novo: novoEstoque, quantidade_baixada: quantidade, alerta_estoque_baixo: novoEstoque <= (req.cliente.estoque_minimo_alerta || 3) });
});

app.delete('/baixa/:id', authMiddleware, async (req, res) => {
  const { data: baixa } = await supabase.from('baixas').select('*').eq('id', req.params.id).eq('cliente_id', req.cliente.id).single();
  if (!baixa) return res.status(404).json({ error: 'Baixa nao encontrada' });
  if ((Date.now() - new Date(baixa.criado_em).getTime()) / 60000 > 60) return res.status(400).json({ error: 'So e possivel estornar baixas das ultimas 60 minutos' });
  try {
    const mlToken = await getMLTokenCliente(req.cliente);
    await axios.put(`https://api.mercadolibre.com/items/${baixa.anuncio_id}`, { available_quantity: baixa.estoque_antes }, { headers: { Authorization: `Bearer ${mlToken}` } });
    await supabase.from('anuncios').update({ estoque: baixa.estoque_antes, atualizado_em: new Date().toISOString() }).eq('id', baixa.anuncio_id);
    await supabase.from('baixas').delete().eq('id', baixa.id);
    res.json({ ok: true, estoque_restaurado: baixa.estoque_antes });
  } catch { res.status(500).json({ error: 'Erro ao estornar no ML' }); }
});

app.get('/historico', authMiddleware, async (req, res) => {
  const seteDias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('baixas').select('*').eq('cliente_id', req.cliente.id).gte('criado_em', seteDias).order('criado_em', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: 'Erro ao buscar historico' });
  res.json(data);
});

app.get('/pendentes', authMiddleware, async (req, res) => {
  const seteDias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('pendentes').select('*').eq('cliente_id', req.cliente.id).eq('resolvido', false).gte('criado_em', seteDias).order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: 'Erro ao buscar pendentes' });
  res.json(data);
});

app.post('/pendentes/:id/reprocessar', authMiddleware, async (req, res) => {
  const { data: pendente } = await supabase.from('pendentes').select('*').eq('id', req.params.id).eq('cliente_id', req.cliente.id).single();
  if (!pendente) return res.status(404).json({ error: 'Pendente nao encontrado' });
  const { data: produto } = await supabase.from('anuncios').select('*').eq('cliente_id', req.cliente.id).eq('ean', pendente.ean).single();
  if (!produto) return res.status(404).json({ error: 'Produto nao encontrado. Sincronize.' });
  const novoEstoque = Math.max(0, produto.estoque - pendente.quantidade);
  try {
    const mlToken = await getMLTokenCliente(req.cliente);
    await axios.put(`https://api.mercadolibre.com/items/${produto.ml_item_id}`, { available_quantity: novoEstoque }, { headers: { Authorization: `Bearer ${mlToken}` } });
    await supabase.from('anuncios').update({ estoque: novoEstoque, atualizado_em: new Date().toISOString() }).eq('id', produto.id);
    await supabase.from('baixas').insert({ cliente_id: req.cliente.id, anuncio_id: produto.id, produto_nome: produto.nome, ean: produto.ean, quantidade: pendente.quantidade, estoque_antes: produto.estoque, estoque_depois: novoEstoque, criado_em: new Date().toISOString() });
    await supabase.from('pendentes').update({ resolvido: true, atualizado_em: new Date().toISOString() }).eq('id', pendente.id);
    res.json({ ok: true, produto: produto.nome, estoque_novo: novoEstoque });
  } catch (err) {
    await supabase.from('pendentes').update({ tentativas: (pendente.tentativas || 1) + 1, atualizado_em: new Date().toISOString() }).eq('id', pendente.id);
    res.status(503).json({ error: 'Falha ao reprocessar. Tente novamente.' });
  }
});

app.delete('/pendentes/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('pendentes').delete().eq('id', req.params.id).eq('cliente_id', req.cliente.id);
  if (error) return res.status(500).json({ error: 'Erro ao deletar pendente' });
  res.json({ ok: true });
});

app.get('/eans-desconhecidos', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('eans_desconhecidos').select('*').eq('cliente_id', req.cliente.id).order('quantidade_tentativas', { ascending: false });
  if (error) return res.status(500).json({ error: 'Erro ao buscar EANs' });
  res.json(data);
});

app.delete('/eans-desconhecidos/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('eans_desconhecidos').delete().eq('id', req.params.id).eq('cliente_id', req.cliente.id);
  if (error) return res.status(500).json({ error: 'Erro ao deletar EAN' });
  res.json({ ok: true });
});

app.get('/sync-status', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('config').select('valor').eq('chave', `ultima_sync_${req.cliente.id}`).single();
  res.json({ ultima_sync: data?.valor || null });
});

app.post('/sincronizar', authMiddleware, async (req, res) => {
  if (!req.cliente.ml_autorizado) return res.status(403).json({ error: 'Cliente nao autorizou o ML ainda.' });
  try {
    const mlToken = await getMLTokenCliente(req.cliente);
    const meRes = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${mlToken}` } });
    const userId = meRes.data.id;
    let offset = 0; const limit = 50; const todos = [];
    while (true) {
      const listRes = await axios.get(`https://api.mercadolibre.com/users/${userId}/items/search?limit=${limit}&offset=${offset}`, { headers: { Authorization: `Bearer ${mlToken}` } });
      const ids = listRes.data.results;
      if (!ids.length) break;
      const chunks = [];
      for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
      for (const chunk of chunks) {
        const detalhes = await axios.get(`https://api.mercadolibre.com/items?ids=${chunk.join(',')}&include_attributes=all`, { headers: { Authorization: `Bearer ${mlToken}` } });
        for (const item of detalhes.data) {
          if (item.code !== 200) continue;
          const body = item.body;
          const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];
          if (req.cliente.usa_variacoes && body.variations && body.variations.length > 0) {
            for (const variation of body.variations) {
              if ((variation.available_quantity || 0) <= 0) continue;
              let eanVar = null;
              for (const eid of EAN_IDS) {
                const a = (variation.attributes || []).find(x => x.id === eid) || (variation.attribute_combinations || []).find(x => x.id === eid);
                if (a?.values?.[0]?.name) { eanVar = a.values[0].name; break; }
              }
              if (!eanVar) eanVar = extrairEAN(body);
              const nomeAttr = (variation.attributes || []).concat(variation.attribute_combinations || []).find(x => ['SIZE','SHOES_SIZE','CLOTHING_SIZE','SELLER_CUSTOM_FIELD'].includes(x.id));
              todos.push({ cliente_id: req.cliente.id, ml_item_id: body.id, variacao_id: String(variation.id), variacao_nome: nomeAttr?.values?.[0]?.name || `Var ${variation.id}`, nome: body.title, ean: eanVar, estoque: variation.available_quantity || 0, preco: body.price, status: body.status, atualizado_em: new Date().toISOString() });
            }
          } else {
            todos.push({ cliente_id: req.cliente.id, ml_item_id: body.id, variacao_id: null, variacao_nome: null, nome: body.title, ean: extrairEAN(body), estoque: body.available_quantity, preco: body.price, status: body.status, atualizado_em: new Date().toISOString() });
          }
        }
      }
      offset += limit;
      if (offset >= listRes.data.paging.total) break;
    }
    if (todos.length > 0) {
      await supabase.from('anuncios').delete().eq('cliente_id', req.cliente.id);
      await supabase.from('anuncios').insert(todos);
    }
    await supabase.from('config').upsert({ chave: `ultima_sync_${req.cliente.id}`, valor: new Date().toISOString(), atualizado_em: new Date().toISOString() });
    res.json({ ok: true, total: todos.length, mensagem: `${todos.length} anuncios sincronizados` });
  } catch (err) {
    console.error('SYNC ERROR:', err.message);
    res.status(500).json({ error: 'Erro ao sincronizar anuncios' });
  }
});

// ROTAS ADMIN
app.get('/admin/clientes', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('clientes').select('*').order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/admin/clientes', adminAuth, async (req, res) => {
  const { nome_loja, token, dispositivos_max, data_vencimento } = req.body;
  if (!nome_loja || !token) return res.status(400).json({ error: 'Nome e token obrigatorios' });
  const { data, error } = await supabase.from('clientes').insert({ nome_loja, token, dispositivos_max: dispositivos_max || 2, ativo: true, data_vencimento: data_vencimento || null, criado_em: new Date().toISOString() }).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.put('/admin/clientes/:id', adminAuth, async (req, res) => {
  const { ativo, data_vencimento, estoque_minimo_alerta } = req.body;
  const updates = {};
  if (ativo !== undefined) updates.ativo = ativo;
  if (data_vencimento !== undefined) updates.data_vencimento = data_vencimento;
  if (estoque_minimo_alerta !== undefined) updates.estoque_minimo_alerta = estoque_minimo_alerta;
  const { data, error } = await supabase.from('clientes').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.delete('/admin/clientes/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('clientes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error });
  res.json({ ok: true });
});

app.get('/admin/link-ml/:clienteId', adminAuth, async (req, res) => {
  const { data: cliente } = await supabase.from('clientes').select('id, nome_loja, token').eq('id', req.params.clienteId).single();
  if (!cliente) return res.status(404).json({ error: 'Cliente nao encontrado' });
  const state = Buffer.from(JSON.stringify({ clienteId: cliente.id, token: cliente.token })).toString('base64');
  const link = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}&state=${state}`;
  res.json({ link, loja: cliente.nome_loja });
});

app.get('/admin/baixas', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('baixas').select('*, clientes(nome_loja)').order('criado_em', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get('/admin/resumo', adminAuth, async (req, res) => {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  const { data: clientes } = await supabase.from('clientes').select('*');
  const { data: baixasMes } = await supabase.from('baixas').select('cliente_id').gte('criado_em', inicioMes.toISOString());
  const { data: pendentes } = await supabase.from('pendentes').select('cliente_id').eq('resolvido', false);
  const { data: eans } = await supabase.from('eans_desconhecidos').select('cliente_id');
  const resumo = (clientes || []).map(c => ({ ...c, baixas_mes: (baixasMes || []).filter(b => b.cliente_id === c.id).length, falhas_pendentes: (pendentes || []).filter(p => p.cliente_id === c.id).length, eans_desconhecidos: (eans || []).filter(e => e.cliente_id === c.id).length }));
  res.json(resumo);
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

async function sincronizarCliente(cliente) {
  if (!cliente.ml_autorizado || !cliente.ml_refresh_token) { console.log(`[AUTO-SYNC] ${cliente.nome_loja}: pulado (sem autorizacao ML)`); return; }
  try {
    const mlToken = await getMLTokenCliente(cliente);
    const meRes = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${mlToken}` } });
    const userId = meRes.data.id;
    let offset = 0; const limit = 50; const todos = [];
    while (true) {
      const listRes = await axios.get(`https://api.mercadolibre.com/users/${userId}/items/search?limit=${limit}&offset=${offset}`, { headers: { Authorization: `Bearer ${mlToken}` } });
      const ids = listRes.data.results;
      if (!ids.length) break;
      const chunks = [];
      for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
      for (const chunk of chunks) {
        const detalhes = await axios.get(`https://api.mercadolibre.com/items?ids=${chunk.join(',')}&include_attributes=all`, { headers: { Authorization: `Bearer ${mlToken}` } });
        for (const item of detalhes.data) {
          if (item.code !== 200) continue;
          const body = item.body;
          const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];
          if (cliente.usa_variacoes && body.variations && body.variations.length > 0) {
            for (const variation of body.variations) {
              if ((variation.available_quantity || 0) <= 0) continue;
              let eanVar = null;
              for (const eid of EAN_IDS) {
                const a = (variation.attributes || []).find(x => x.id === eid) || (variation.attribute_combinations || []).find(x => x.id === eid);
                if (a?.values?.[0]?.name) { eanVar = a.values[0].name; break; }
              }
              if (!eanVar) eanVar = extrairEAN(body);
              const nomeAttr = (variation.attributes || []).concat(variation.attribute_combinations || []).find(x => ['SIZE','SHOES_SIZE','CLOTHING_SIZE','SELLER_CUSTOM_FIELD'].includes(x.id));
              todos.push({ cliente_id: cliente.id, ml_item_id: body.id, variacao_id: String(variation.id), variacao_nome: nomeAttr?.values?.[0]?.name || `Var ${variation.id}`, nome: body.title, ean: eanVar, estoque: variation.available_quantity || 0, preco: body.price, status: body.status, atualizado_em: new Date().toISOString() });
            }
          } else {
            todos.push({ cliente_id: cliente.id, ml_item_id: body.id, variacao_id: null, variacao_nome: null, nome: body.title, ean: extrairEAN(body), estoque: body.available_quantity, preco: body.price, status: body.status, atualizado_em: new Date().toISOString() });
          }
        }
      }
      offset += limit;
      if (offset >= listRes.data.paging.total) break;
    }
    if (todos.length > 0) {
      await supabase.from('anuncios').delete().eq('cliente_id', cliente.id);
      await supabase.from('anuncios').insert(todos);
    }
    await supabase.from('config').upsert({ chave: `ultima_sync_${cliente.id}`, valor: new Date().toISOString(), atualizado_em: new Date().toISOString() });
    console.log(`[AUTO-SYNC] ${cliente.nome_loja}: ${todos.length} anuncios`);
  } catch (err) { console.error(`[AUTO-SYNC] Erro em ${cliente.nome_loja}:`, err.message); }
}

async function sincronizacaoAutomatica() {
  try {
    const { data: clientes } = await supabase.from('clientes').select('*').eq('ativo', true);
    if (!clientes || !clientes.length) return;
    for (const c of clientes) await sincronizarCliente(c);
  } catch (err) { console.error('[AUTO-SYNC] Erro geral:', err.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Horizon Estoque API rodando na porta ${PORT}`);
  sincronizacaoAutomatica();
  setInterval(sincronizacaoAutomatica, 6 * 60 * 60 * 1000);
});
