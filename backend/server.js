const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI  = 'https://horizon-estoque.onrender.com/auth/ml/callback';

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

// ── TOKEN: renova o access_token de uma conta ML específica ──────────────────
async function getMLTokenConta(conta) {
  console.log('[TOKEN] Renovando token para conta:', conta.nickname, '| id:', conta.id, '| tem refresh_token:', !!conta.refresh_token);
  if (!conta.refresh_token) throw new Error('Conta sem refresh_token.');
  try {
    const res = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type:    'refresh_token',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conta.refresh_token
    });
    await supabase.from('ml_contas').update({
      access_token:  res.data.access_token,
      refresh_token: res.data.refresh_token,
      atualizado_em: new Date().toISOString()
    }).eq('id', conta.id);
    return res.data.access_token;
  } catch (err) {
    console.error('[TOKEN ERROR] conta:', conta.nickname, '| status:', err.response?.status, '| data:', JSON.stringify(err.response?.data));
    throw new Error('Falha ao renovar token ML da conta ' + (conta.nickname || conta.id));
  }
}

// ── COMPATIBILIDADE: para rotas que ainda usam req.cliente direto ────────────
async function getMLTokenCliente(cliente) {
  const { data: contas } = await supabase
    .from('ml_contas')
    .select('*')
    .eq('cliente_id', cliente.id)
    .eq('ativo', true)
    .limit(1)
    .single();
  if (!contas) throw new Error('Nenhuma conta ML conectada.');
  return getMLTokenConta(contas);
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

// ── OAUTH CALLBACK ────────────────────────────────────────────────────────────
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

  // Verificar limite de 5 contas
  const { data: contasExistentes } = await supabase
    .from('ml_contas').select('id').eq('cliente_id', clienteId).eq('ativo', true);
  if ((contasExistentes || []).length >= 5) {
    return res.send(`<html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;background:#FDF5F7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:white;border-radius:16px;padding:40px;text-align:center;max-width:400px}h2{color:#9E3A4F}</style></head><body><div class="box"><div style="font-size:48px">&#9888;</div><h2>Limite atingido</h2><p>Esta loja ja possui 5 contas do Mercado Livre conectadas (limite maximo).</p><p style="margin-top:16px;color:#9B7F8A">Entre em contato com a Horizon Consultoria para gerenciar as contas.</p></div></body></html>`);
  }

  try {
    const tokenRes = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type:    'authorization_code',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri:  ML_REDIRECT_URI
    });

    // Buscar nickname do usuário ML
    let nickname = `Conta ${(contasExistentes || []).length + 1}`;
    try {
      const meRes = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
      });
      nickname = meRes.data.nickname || meRes.data.email || nickname;
    } catch {}

    const mlUserId = String(tokenRes.data.user_id);

    // Upsert: se conta ja existe (reconectando), atualiza tokens
    await supabase.from('ml_contas').upsert({
      cliente_id:    clienteId,
      ml_user_id:    mlUserId,
      nickname,
      access_token:  tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      ativo:         true,
      atualizado_em: new Date().toISOString()
    }, { onConflict: 'cliente_id,ml_user_id' });

    // Atualizar flag ml_autorizado no cliente (compatibilidade)
    await supabase.from('clientes').update({
      ml_autorizado:    true,
      ml_autorizado_em: new Date().toISOString()
    }).eq('id', clienteId);

    const agora = new Date().toLocaleString('pt-BR');
    enviarEmailAdmin(
      `[Horizon] ${cliente.nome_loja} conectou conta ML: ${nickname}`,
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#1A3C6E">Nova conta ML conectada</h2>
        <p>A loja <strong>${cliente.nome_loja}</strong> conectou uma conta do Mercado Livre.</p>
        <table style="width:100%;margin-top:16px;font-size:13px;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#7A8EA8">Loja</td><td><strong>${cliente.nome_loja}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#7A8EA8">Conta ML</td><td><strong>${nickname}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#7A8EA8">ML User ID</td><td>${mlUserId}</td></tr>
          <tr><td style="padding:6px 0;color:#7A8EA8">Total contas</td><td>${(contasExistentes || []).length + 1}/5</td></tr>
          <tr><td style="padding:6px 0;color:#7A8EA8">Data/hora</td><td>${agora}</td></tr>
        </table>
        <p style="margin-top:20px;font-size:12px;color:#7A8EA8">Acesse o painel admin para sincronizar os anuncios.</p>
      </div>`
    );

    return res.send(`<html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;background:#FDF5F7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:white;border-radius:16px;padding:40px;text-align:center;max-width:400px}h2{color:#9E3A4F}</style></head><body><div class="box"><div style="font-size:48px">&#10003;</div><h2>Conta conectada!</h2><p>A conta <strong>${nickname}</strong> foi vinculada com sucesso a loja <strong>${cliente.nome_loja}</strong>.</p><p style="margin-top:16px;color:#9B7F8A">Voce ja pode fechar esta janela.</p></div></body></html>`);
  } catch (err) {
    console.error('OAUTH ERROR:', err.response?.data);
    return res.status(500).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Erro ao autorizar</h2><pre>${JSON.stringify(err.response?.data)}</pre></body></html>`);
  }
});

// ── ROTAS CLIENTE ─────────────────────────────────────────────────────────────

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
  const { data, error } = await supabase
    .from('anuncios')
    .select('*, ml_contas(nickname)')
    .eq('cliente_id', req.cliente.id)
    .order('nome');
  if (error) return res.status(500).json({ error: 'Erro ao buscar anuncios' });
  res.json(data);
});

app.get('/produto/:ean', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('anuncios')
    .select('*, ml_contas(nickname)')
    .eq('cliente_id', req.cliente.id)
    .eq('ean', req.params.ean)
    .order('estoque', { ascending: true }); // menor estoque primeiro
  if (error || !data || data.length === 0) return res.status(404).json({ error: 'Produto nao encontrado' });
  // Retorna o de menor estoque (primeiro da lista)
  res.json(data[0]);
});

// ── BAIXA: busca em todas as contas, dá baixa na de menor estoque ─────────────
app.put('/baixa', authMiddleware, async (req, res) => {
  const { ean, quantidade } = req.body;
  if (!ean || !quantidade || quantidade < 1) return res.status(400).json({ error: 'EAN e quantidade sao obrigatorios' });

  // Busca o produto em TODAS as contas, ordena por menor estoque
  const { data: produtos } = await supabase
    .from('anuncios')
    .select('*, ml_contas(id, nickname, refresh_token, access_token)')
    .eq('cliente_id', req.cliente.id)
    .eq('ean', ean)
    .order('estoque', { ascending: true });

  if (!produtos || produtos.length === 0) {
    await supabase.from('eans_desconhecidos').upsert(
      { cliente_id: req.cliente.id, ean, quantidade_tentativas: 1, atualizado_em: new Date().toISOString() },
      { onConflict: 'cliente_id,ean', ignoreDuplicates: false }
    ).catch(() => {});
    return res.status(404).json({ error: 'Produto nao encontrado', tipo: 'ean_desconhecido' });
  }

  // Pega o produto com menor estoque que ainda tenha saldo suficiente
  const produto = produtos.find(p => p.estoque >= quantidade) || produtos[0];

  if (produto.estoque < quantidade) {
    return res.status(400).json({ error: `Estoque insuficiente. Disponivel: ${produto.estoque}` });
  }

  // Buscar conta SEMPRE diretamente (evita problema de RLS no JOIN)
  if (!produto.ml_conta_id) {
    console.error('[BAIXA] Produto sem ml_conta_id:', produto.ml_item_id);
    return res.status(503).json({ error: 'Produto sem conta ML vinculada. Sincronize novamente.' });
  }
  const { data: conta, error: contaErr } = await supabase.from('ml_contas').select('*').eq('id', produto.ml_conta_id).single();
  console.log('[BAIXA] Conta buscada:', conta?.nickname, '| erro:', contaErr?.message);
  if (!conta) {
    console.error('[BAIXA] Conta ML nao encontrada, ml_conta_id:', produto.ml_conta_id);
    return res.status(503).json({ error: 'Conta ML nao encontrada. Sincronize novamente.' });
  }

  const novoEstoque = produto.estoque - quantidade;
  const nickname = conta.nickname || 'Conta ML';

  try {
    const mlToken = await getMLTokenConta(conta);
    await axios.put(
      `https://api.mercadolibre.com/items/${produto.ml_item_id}`,
      { available_quantity: novoEstoque },
      { headers: { Authorization: `Bearer ${mlToken}` } }
    );
  } catch (err) {
    await supabase.from('pendentes').insert({
      cliente_id:    req.cliente.id,
      ean:           produto.ean,
      produto_nome:  produto.nome,
      variacao_nome: produto.variacao_nome,
      quantidade,
      ml_conta_id:   conta.id,
      ml_nickname:   nickname,
      motivo_falha:  err.message || 'Erro de conexao',
      tentativas:    1,
      resolvido:     false,
      criado_em:     new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    });
    return res.status(503).json({ error: 'Falha na conexao com ML. Baixa salva na fila.', tipo: 'pendente' });
  }

  await supabase.from('anuncios')
    .update({ estoque: novoEstoque, atualizado_em: new Date().toISOString() })
    .eq('id', produto.id);

  const { data: baixaInserida } = await supabase.from('baixas').insert({
    cliente_id:     req.cliente.id,
    anuncio_id:     produto.id,
    produto_nome:   produto.nome,
    ean:            produto.ean,
    quantidade,
    estoque_antes:  produto.estoque,
    estoque_depois: novoEstoque,
    ml_conta_id:    conta.id,
    ml_nickname:    nickname,
    criado_em:      new Date().toISOString()
  }).select().single();

  res.json({
    ok:                    true,
    baixa_id:              baixaInserida?.id,
    produto:               produto.nome,
    variacao:              produto.variacao_nome,
    conta_ml:              nickname,
    estoque_anterior:      produto.estoque,
    estoque_novo:          novoEstoque,
    quantidade_baixada:    quantidade,
    alerta_estoque_baixo:  novoEstoque <= (req.cliente.estoque_minimo_alerta || 3)
  });
});

app.delete('/baixa/:id', authMiddleware, async (req, res) => {
  const { data: baixa } = await supabase.from('baixas').select('*').eq('id', req.params.id).eq('cliente_id', req.cliente.id).single();
  if (!baixa) return res.status(404).json({ error: 'Baixa nao encontrada' });
  if ((Date.now() - new Date(baixa.criado_em).getTime()) / 60000 > 60) return res.status(400).json({ error: 'So e possivel estornar baixas das ultimas 60 minutos' });

  const { data: anuncio } = await supabase.from('anuncios').select('ml_item_id').eq('id', baixa.anuncio_id).single();

  try {
    // Usar conta ML registrada na baixa
    let mlToken;
    if (baixa.ml_conta_id) {
      const { data: conta } = await supabase.from('ml_contas').select('*').eq('id', baixa.ml_conta_id).single();
      mlToken = await getMLTokenConta(conta);
    } else {
      mlToken = await getMLTokenCliente(req.cliente);
    }

    await axios.put(
      `https://api.mercadolibre.com/items/${anuncio?.ml_item_id || baixa.anuncio_id}`,
      { available_quantity: baixa.estoque_antes },
      { headers: { Authorization: `Bearer ${mlToken}` } }
    );
    await supabase.from('anuncios').update({ estoque: baixa.estoque_antes, atualizado_em: new Date().toISOString() }).eq('id', baixa.anuncio_id);
    await supabase.from('baixas').delete().eq('id', baixa.id);
    res.json({ ok: true, estoque_restaurado: baixa.estoque_antes });
  } catch { res.status(500).json({ error: 'Erro ao estornar no ML' }); }
});

app.get('/historico', authMiddleware, async (req, res) => {
  const seteDias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('baixas')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .gte('criado_em', seteDias)
    .order('criado_em', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: 'Erro ao buscar historico' });
  res.json(data);
});

app.get('/pendentes', authMiddleware, async (req, res) => {
  const seteDias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('pendentes')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('resolvido', false)
    .gte('criado_em', seteDias)
    .order('criado_em', { ascending: false });
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
    let mlToken;
    if (pendente.ml_conta_id) {
      const { data: conta } = await supabase.from('ml_contas').select('*').eq('id', pendente.ml_conta_id).single();
      mlToken = await getMLTokenConta(conta);
    } else {
      mlToken = await getMLTokenCliente(req.cliente);
    }

    await axios.put(
      `https://api.mercadolibre.com/items/${produto.ml_item_id}`,
      { available_quantity: novoEstoque },
      { headers: { Authorization: `Bearer ${mlToken}` } }
    );
    await supabase.from('anuncios').update({ estoque: novoEstoque, atualizado_em: new Date().toISOString() }).eq('id', produto.id);
    await supabase.from('baixas').insert({
      cliente_id: req.cliente.id, anuncio_id: produto.id, produto_nome: produto.nome,
      ean: produto.ean, quantidade: pendente.quantidade, estoque_antes: produto.estoque,
      estoque_depois: novoEstoque, ml_conta_id: pendente.ml_conta_id, ml_nickname: pendente.ml_nickname,
      criado_em: new Date().toISOString()
    });
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

// ── CONTAS ML DO CLIENTE ──────────────────────────────────────────────────────
app.get('/contas-ml', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('ml_contas')
    .select('id, nickname, ml_user_id, ativo, criado_em')
    .eq('cliente_id', req.cliente.id)
    .order('criado_em');
  if (error) return res.status(500).json({ error: 'Erro ao buscar contas' });
  res.json(data);
});

// ── SINCRONIZAR: percorre todas as contas ML do cliente ───────────────────────
app.post('/sincronizar', authMiddleware, async (req, res) => {
  const { data: contas } = await supabase
    .from('ml_contas')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('ativo', true);

  if (!contas || contas.length === 0) {
    return res.status(403).json({ error: 'Nenhuma conta ML conectada. Solicite o link de autorizacao.' });
  }

  let totalSincronizados = 0;
  const erros = [];

  // Apaga todos os anuncios do cliente antes de reinserir
  await supabase.from('anuncios').delete().eq('cliente_id', req.cliente.id);

  for (const conta of contas) {
    try {
      const mlToken = await getMLTokenConta(conta);
      const meRes = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${mlToken}` } });
      const userId = meRes.data.id;

      let offset = 0; const limit = 50; const todos = [];

      while (true) {
        const listRes = await axios.get(
          `https://api.mercadolibre.com/users/${userId}/items/search?limit=${limit}&offset=${offset}`,
          { headers: { Authorization: `Bearer ${mlToken}` } }
        );
        const ids = listRes.data.results;
        if (!ids.length) break;

        const chunks = [];
        for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

        for (const chunk of chunks) {
          const detalhes = await axios.get(
            `https://api.mercadolibre.com/items?ids=${chunk.join(',')}&include_attributes=all`,
            { headers: { Authorization: `Bearer ${mlToken}` } }
          );
          for (const item of detalhes.data) {
            if (item.code !== 200) continue;
            const body = item.body;
            const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];

            if (body.status !== 'active') continue;
            if (req.cliente.usa_variacoes && body.variations && body.variations.length > 0) {
              for (const variation of body.variations) {
                if ((variation.available_quantity || 0) <= 0) continue;
                let eanVar = null;
                for (const eid of EAN_IDS) {
                  const a = (variation.attributes || []).find(x => x.id === eid) || (variation.attribute_combinations || []).find(x => x.id === eid);
                  if (a?.values?.[0]?.name) { eanVar = a.values[0].name; break; }
                }
                if (!eanVar) eanVar = extrairEAN(body);
                const nomeAttr = (variation.attributes || []).concat(variation.attribute_combinations || []).find(x =>
                  ['SIZE', 'SHOES_SIZE', 'CLOTHING_SIZE', 'SELLER_CUSTOM_FIELD'].includes(x.id)
                );
                todos.push({
                  cliente_id: req.cliente.id, ml_conta_id: conta.id,
                  ml_item_id: body.id, variacao_id: String(variation.id),
                  variacao_nome: nomeAttr?.values?.[0]?.name || `Var ${variation.id}`,
                  nome: body.title, ean: eanVar, estoque: variation.available_quantity || 0,
                  preco: body.price, status: body.status, atualizado_em: new Date().toISOString()
                });
              }
            } else {
              todos.push({
                cliente_id: req.cliente.id, ml_conta_id: conta.id,
                ml_item_id: body.id, variacao_id: null, variacao_nome: null,
                nome: body.title, ean: extrairEAN(body), estoque: body.available_quantity,
                preco: body.price, status: body.status, atualizado_em: new Date().toISOString()
              });
            }
          }
        }
        offset += limit;
        if (offset >= listRes.data.paging.total) break;
      }

      if (todos.length > 0) await supabase.from('anuncios').insert(todos);
      totalSincronizados += todos.length;
      console.log(`[SYNC] ${conta.nickname}: ${todos.length} anuncios`);

    } catch (err) {
      console.error(`[SYNC] Erro na conta ${conta.nickname}:`, err.message);
      erros.push({ conta: conta.nickname, erro: err.message });
    }
  }

  await supabase.from('config').upsert({
    chave: `ultima_sync_${req.cliente.id}`,
    valor: new Date().toISOString(),
    atualizado_em: new Date().toISOString()
  });

  res.json({
    ok:       true,
    total:    totalSincronizados,
    contas:   contas.length,
    erros,
    mensagem: `${totalSincronizados} anuncios sincronizados de ${contas.length} conta(s)`
  });
});

// ── ROTAS ADMIN ───────────────────────────────────────────────────────────────

app.get('/admin/clientes', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('clientes').select('*').order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/admin/clientes', adminAuth, async (req, res) => {
  const { nome_loja, token, dispositivos_max, data_vencimento } = req.body;
  if (!nome_loja || !token) return res.status(400).json({ error: 'Nome e token obrigatorios' });
  const { data, error } = await supabase.from('clientes').insert({
    nome_loja, token, dispositivos_max: dispositivos_max || 2,
    ativo: true, data_vencimento: data_vencimento || null,
    criado_em: new Date().toISOString()
  }).select().single();
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

// GERAR LINK ML — agora funciona para adicionar conta nova ou primeira conta
app.get('/admin/link-ml/:clienteId', adminAuth, async (req, res) => {
  const { data: cliente } = await supabase.from('clientes').select('id, nome_loja, token').eq('id', req.params.clienteId).single();
  if (!cliente) return res.status(404).json({ error: 'Cliente nao encontrado' });

  // Verificar quantas contas já tem
  const { data: contas } = await supabase.from('ml_contas').select('id, nickname').eq('cliente_id', cliente.id).eq('ativo', true);
  if ((contas || []).length >= 5) {
    return res.status(400).json({ error: 'Limite de 5 contas atingido para este cliente.' });
  }

  const state = Buffer.from(JSON.stringify({ clienteId: cliente.id, token: cliente.token })).toString('base64');
  const link  = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}&state=${state}&prompt=login`;

  res.json({
    link,
    loja:         cliente.nome_loja,
    contas_ativas: (contas || []).length,
    slots_restantes: 5 - (contas || []).length
  });
});

// LISTAR CONTAS ML DE UM CLIENTE (admin)
app.get('/admin/clientes/:id/contas-ml', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('ml_contas')
    .select('id, nickname, ml_user_id, ativo, criado_em, atualizado_em')
    .eq('cliente_id', req.params.id)
    .order('criado_em');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// REMOVER CONTA ML (admin) — deleta o registro completamente
app.delete('/admin/contas-ml/:contaId', adminAuth, async (req, res) => {
  // Buscar ml_user_id antes de deletar para remover anuncios vinculados
  const { data: conta } = await supabase.from('ml_contas').select('id, cliente_id, ml_user_id').eq('id', req.params.contaId).single();
  if (!conta) return res.status(404).json({ error: 'Conta nao encontrada' });

  // Deletar anuncios dessa conta
  await supabase.from('anuncios').delete().eq('ml_conta_id', conta.id);

  // Deletar a conta
  const { error } = await supabase.from('ml_contas').delete().eq('id', req.params.contaId);
  if (error) return res.status(500).json({ error });

  res.json({ ok: true });
});

app.get('/admin/baixas', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('baixas')
    .select('*, clientes(nome_loja)')
    .order('criado_em', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get('/admin/resumo', adminAuth, async (req, res) => {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
  const { data: clientes }   = await supabase.from('clientes').select('*');
  const { data: baixasMes }  = await supabase.from('baixas').select('cliente_id').gte('criado_em', inicioMes.toISOString());
  const { data: pendentes }  = await supabase.from('pendentes').select('cliente_id').eq('resolvido', false);
  const { data: eans }       = await supabase.from('eans_desconhecidos').select('cliente_id');
  const { data: todasContas } = await supabase.from('ml_contas').select('cliente_id').eq('ativo', true);

  const resumo = (clientes || []).map(c => ({
    ...c,
    baixas_mes:         (baixasMes  || []).filter(b => b.cliente_id === c.id).length,
    falhas_pendentes:   (pendentes  || []).filter(p => p.cliente_id === c.id).length,
    eans_desconhecidos: (eans       || []).filter(e => e.cliente_id === c.id).length,
    contas_ml:          (todasContas|| []).filter(x => x.cliente_id === c.id).length
  }));
  res.json(resumo);
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── AUTO-SYNC ─────────────────────────────────────────────────────────────────
async function sincronizarCliente(cliente) {
  const { data: contas } = await supabase
    .from('ml_contas').select('*').eq('cliente_id', cliente.id).eq('ativo', true);

  if (!contas || contas.length === 0) {
    console.log(`[AUTO-SYNC] ${cliente.nome_loja}: sem contas ML`); return;
  }

  await supabase.from('anuncios').delete().eq('cliente_id', cliente.id);

  for (const conta of contas) {
    try {
      const mlToken = await getMLTokenConta(conta);
      const meRes = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${mlToken}` } });
      const userId = meRes.data.id;

      let offset = 0; const limit = 50; const todos = [];

      while (true) {
        const listRes = await axios.get(
          `https://api.mercadolibre.com/users/${userId}/items/search?limit=${limit}&offset=${offset}`,
          { headers: { Authorization: `Bearer ${mlToken}` } }
        );
        const ids = listRes.data.results;
        if (!ids.length) break;

        const chunks = [];
        for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

        for (const chunk of chunks) {
          const detalhes = await axios.get(
            `https://api.mercadolibre.com/items?ids=${chunk.join(',')}&include_attributes=all`,
            { headers: { Authorization: `Bearer ${mlToken}` } }
          );
          for (const item of detalhes.data) {
            if (item.code !== 200) continue;
            const body = item.body;
            const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];

            if (body.status !== 'active') continue;
            if (cliente.usa_variacoes && body.variations && body.variations.length > 0) {
              for (const variation of body.variations) {
                if ((variation.available_quantity || 0) <= 0) continue;
                let eanVar = null;
                for (const eid of EAN_IDS) {
                  const a = (variation.attributes || []).find(x => x.id === eid) || (variation.attribute_combinations || []).find(x => x.id === eid);
                  if (a?.values?.[0]?.name) { eanVar = a.values[0].name; break; }
                }
                if (!eanVar) eanVar = extrairEAN(body);
                const nomeAttr = (variation.attributes || []).concat(variation.attribute_combinations || []).find(x =>
                  ['SIZE', 'SHOES_SIZE', 'CLOTHING_SIZE', 'SELLER_CUSTOM_FIELD'].includes(x.id)
                );
                todos.push({
                  cliente_id: cliente.id, ml_conta_id: conta.id,
                  ml_item_id: body.id, variacao_id: String(variation.id),
                  variacao_nome: nomeAttr?.values?.[0]?.name || `Var ${variation.id}`,
                  nome: body.title, ean: eanVar, estoque: variation.available_quantity || 0,
                  preco: body.price, status: body.status, atualizado_em: new Date().toISOString()
                });
              }
            } else {
              todos.push({
                cliente_id: cliente.id, ml_conta_id: conta.id,
                ml_item_id: body.id, variacao_id: null, variacao_nome: null,
                nome: body.title, ean: extrairEAN(body), estoque: body.available_quantity,
                preco: body.price, status: body.status, atualizado_em: new Date().toISOString()
              });
            }
          }
        }
        offset += limit;
        if (offset >= listRes.data.paging.total) break;
      }

      if (todos.length > 0) await supabase.from('anuncios').insert(todos);
      console.log(`[AUTO-SYNC] ${cliente.nome_loja} / ${conta.nickname}: ${todos.length} anuncios`);

    } catch (err) {
      console.error(`[AUTO-SYNC] Erro ${cliente.nome_loja} / ${conta.nickname}:`, err.message);
    }
  }

  await supabase.from('config').upsert({
    chave: `ultima_sync_${cliente.id}`,
    valor: new Date().toISOString(),
    atualizado_em: new Date().toISOString()
  });
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
