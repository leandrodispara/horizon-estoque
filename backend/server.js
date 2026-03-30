const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

let mlAccessToken = null;
let mlTokenExpiry = 0;

async function getRefreshToken() {
  const { data, error } = await supabase
    .from('config')
    .select('valor')
    .eq('chave', 'ml_refresh_token')
    .single();
  if (error || !data) return process.env.ML_REFRESH_TOKEN;
  return data.valor;
}

async function saveRefreshToken(token) {
  await supabase
    .from('config')
    .upsert({ chave: 'ml_refresh_token', valor: token, atualizado_em: new Date().toISOString() });
}

async function getMLToken() {
  if (mlAccessToken && Date.now() < mlTokenExpiry) return mlAccessToken;
  try {
    const refreshToken = await getRefreshToken();
    const res = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: refreshToken
    });
    mlAccessToken = res.data.access_token;
    mlTokenExpiry = Date.now() + (res.data.expires_in - 300) * 1000;
    if (res.data.refresh_token) {
      await saveRefreshToken(res.data.refresh_token);
    }
    return mlAccessToken;
  } catch (err) {
    const errData = err.response?.data;
    const errStatus = err.response?.status;
    console.error('ML AUTH ERROR:', errStatus, JSON.stringify(errData));
    console.error('TOKEN USADO:', (await getRefreshToken()).substring(0, 20));
    throw new Error('Falha na autenticação com Mercado Livre');
  }
}

async function authMiddleware(req, res, next) {
  const token = req.headers['x-access-token'];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .eq('token', token)
    .single();
  if (error || !data) return res.status(401).json({ error: 'Token inválido' });
  if (!data.ativo) return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com a Horizon Consultoria.' });
  req.cliente = data;
  next();
}

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// ─── ROTAS CLIENTE ───────────────────────────────────────────

app.post('/auth', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token obrigatório' });
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nome_loja, token, ativo, dispositivos_max')
    .eq('token', token)
    .single();
  if (error || !data) return res.status(401).json({ error: 'Código de acesso inválido' });
  if (!data.ativo) return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com a Horizon Consultoria.' });
  res.json({ ok: true, loja: data.nome_loja, clienteId: data.id });
});

app.get('/anuncios', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('anuncios')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .order('nome');
  if (error) return res.status(500).json({ error: 'Erro ao buscar anúncios' });
  res.json(data);
});

app.get('/produto/:ean', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('anuncios')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('ean', req.params.ean)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Produto não encontrado. Sincronize os anúncios.' });
  res.json(data);
});

app.put('/baixa', authMiddleware, async (req, res) => {
  const { ean, quantidade } = req.body;
  if (!ean || !quantidade || quantidade < 1) {
    return res.status(400).json({ error: 'EAN e quantidade são obrigatórios' });
  }
  const { data: produto, error: prodErr } = await supabase
    .from('anuncios')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('ean', ean)
    .single();
  if (prodErr || !produto) return res.status(404).json({ error: 'Produto não encontrado' });
  if (produto.estoque < quantidade) {
    return res.status(400).json({ error: `Estoque insuficiente. Disponível: ${produto.estoque}` });
  }
  const novoEstoque = produto.estoque - quantidade;
  try {
    const token = await getMLToken();
    await axios.put(
      `https://api.mercadolibre.com/items/${produto.ml_item_id}`,
      { available_quantity: novoEstoque },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao atualizar estoque no Mercado Livre' });
  }
  await supabase
    .from('anuncios')
    .update({ estoque: novoEstoque, atualizado_em: new Date().toISOString() })
    .eq('id', produto.id);
  await supabase.from('baixas').insert({
    cliente_id: req.cliente.id,
    anuncio_id: produto.id,
    produto_nome: produto.nome,
    ean: produto.ean,
    quantidade,
    estoque_antes: produto.estoque,
    estoque_depois: novoEstoque,
    criado_em: new Date().toISOString()
  });
  res.json({
    ok: true,
    produto: produto.nome,
    estoque_anterior: produto.estoque,
    estoque_novo: novoEstoque,
    quantidade_baixada: quantidade
  });
});

function extrairEAN(body) {
  const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];

  if (body.attributes) {
    for (const id of EAN_IDS) {
      const attr = body.attributes.find(a => a.id === id);
      if (attr?.values?.[0]?.name) return attr.values[0].name;
    }
  }

  if (body.variations && body.variations.length > 0) {
    for (const variation of body.variations) {
      if (variation.attributes) {
        for (const id of EAN_IDS) {
          const attr = variation.attributes.find(a => a.id === id);
          if (attr?.values?.[0]?.name) return attr.values[0].name;
        }
      }
      if (variation.attribute_combinations) {
        for (const id of EAN_IDS) {
          const attr = variation.attribute_combinations.find(a => a.id === id);
          if (attr?.values?.[0]?.name) return attr.values[0].name;
        }
      }
    }
  }

  return null;
}

app.post('/sincronizar', authMiddleware, async (req, res) => {
  try {
    const token = await getMLToken();
    const meRes = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const userId = meRes.data.id;
    let offset = 0;
    const limit = 50;
    let todos = [];

    while (true) {
      const listRes = await axios.get(
        `https://api.mercadolibre.com/users/${userId}/items/search?limit=${limit}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const ids = listRes.data.results;
      if (!ids.length) break;

      const chunks = [];
      for (let i = 0; i < ids.length; i += 20) {
        chunks.push(ids.slice(i, i + 20));
      }

      for (const chunk of chunks) {
        const detalhes = await axios.get(
          `https://api.mercadolibre.com/items?ids=${chunk.join(',')}&include_attributes=all`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        for (const item of detalhes.data) {
          if (item.code !== 200) continue;
          const body = item.body;
          const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];

          if (body.variations && body.variations.length > 0) {
            for (const variation of body.variations) {
              if ((variation.available_quantity || 0) <= 0) continue;
              let eanVar = null;
              for (const eid of EAN_IDS) {
                const a = (variation.attributes || []).find(x => x.id === eid)
                       || (variation.attribute_combinations || []).find(x => x.id === eid);
                if (a?.values?.[0]?.name) { eanVar = a.values[0].name; break; }
              }
              if (!eanVar) eanVar = extrairEAN(body);
              const nomeAttr = (variation.attributes || []).concat(variation.attribute_combinations || [])
                .find(x => ['SIZE','SHOES_SIZE','CLOTHING_SIZE','SELLER_CUSTOM_FIELD'].includes(x.id));
              const varNome = nomeAttr?.values?.[0]?.name || `Var ${variation.id}`;
              todos.push({
                cliente_id: req.cliente.id,
                ml_item_id: body.id,
                variacao_id: String(variation.id),
                variacao_nome: varNome,
                nome: body.title,
                ean: eanVar,
                estoque: variation.available_quantity || 0,
                preco: body.price,
                status: body.status,
                atualizado_em: new Date().toISOString()
              });
            }
          } else {
            todos.push({
              cliente_id: req.cliente.id,
              ml_item_id: body.id,
              variacao_id: null,
              variacao_nome: null,
              nome: body.title,
              ean: extrairEAN(body),
              estoque: body.available_quantity,
              preco: body.price,
              status: body.status,
              atualizado_em: new Date().toISOString()
            });
          }
        }
      }

      offset += limit;
      if (offset >= listRes.data.paging.total) break;
    }

    for (const anuncio of todos) {
      await supabase
        .from('anuncios')
        .upsert(anuncio, { onConflict: 'cliente_id,ml_item_id,variacao_id' });
    }

    res.json({ ok: true, total: todos.length, mensagem: `${todos.length} anúncios sincronizados` });
  } catch (err) {
    console.error('SYNC ERROR:', err.message, JSON.stringify(err.response?.data), 'status:', err.response?.status);
    res.status(500).json({ error: 'Erro ao sincronizar anúncios' });
  }
});

app.get('/historico', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('baixas')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .order('criado_em', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: 'Erro ao buscar histórico' });
  res.json(data);
});

// ─── ROTAS ADMIN ─────────────────────────────────────────────

app.get('/admin/clientes', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/admin/clientes', adminAuth, async (req, res) => {
  const { nome_loja, token, dispositivos_max } = req.body;
  if (!nome_loja || !token) return res.status(400).json({ error: 'Nome e token obrigatórios' });
  const { data, error } = await supabase
    .from('clientes')
    .insert({ nome_loja, token, dispositivos_max: dispositivos_max || 2, ativo: true, criado_em: new Date().toISOString() })
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.put('/admin/clientes/:id', adminAuth, async (req, res) => {
  const { ativo } = req.body;
  const { data, error } = await supabase
    .from('clientes')
    .update({ ativo })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.delete('/admin/clientes/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('clientes').delete().eq('id', req.params.id);
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

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── SINCRONIZACAO AUTOMATICA A CADA 6 HORAS ─────────────────

async function sincronizarCliente(cliente) {
  try {
    const token = await getMLToken();
    const meRes = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const userId = meRes.data.id;
    let offset = 0;
    const limit = 50;
    let total = 0;

    while (true) {
      const listRes = await axios.get(
        `https://api.mercadolibre.com/users/${userId}/items/search?limit=${limit}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const ids = listRes.data.results;
      if (!ids.length) break;

      const chunks = [];
      for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

      for (const chunk of chunks) {
        const detalhes = await axios.get(
          `https://api.mercadolibre.com/items?ids=${chunk.join(',')}&include_attributes=all`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        for (const item of detalhes.data) {
          if (item.code !== 200) continue;
          const body = item.body;
          const EAN_IDS = ['EAN', 'GTIN', 'UPC', 'ISBN', 'BARCODE'];

          if (body.variations && body.variations.length > 0) {
            for (const variation of body.variations) {
              if ((variation.available_quantity || 0) <= 0) continue;
              let eanVar = null;
              for (const eid of EAN_IDS) {
                const a = (variation.attributes || []).find(x => x.id === eid)
                       || (variation.attribute_combinations || []).find(x => x.id === eid);
                if (a?.values?.[0]?.name) { eanVar = a.values[0].name; break; }
              }
              if (!eanVar) eanVar = extrairEAN(body);
              const nomeAttr = (variation.attributes || []).concat(variation.attribute_combinations || [])
                .find(x => ['SIZE','SHOES_SIZE','CLOTHING_SIZE','SELLER_CUSTOM_FIELD'].includes(x.id));
              const varNome = nomeAttr?.values?.[0]?.name || `Var ${variation.id}`;
              await supabase.from('anuncios').upsert({
                cliente_id: cliente.id,
                ml_item_id: body.id,
                variacao_id: String(variation.id),
                variacao_nome: varNome,
                nome: body.title,
                ean: eanVar,
                estoque: variation.available_quantity || 0,
                preco: body.price,
                status: body.status,
                atualizado_em: new Date().toISOString()
              }, { onConflict: 'cliente_id,ml_item_id,variacao_id' });
              total++;
            }
          } else {
            await supabase.from('anuncios').upsert({
              cliente_id: cliente.id,
              ml_item_id: body.id,
              variacao_id: null,
              variacao_nome: null,
              nome: body.title,
              ean: extrairEAN(body),
              estoque: body.available_quantity,
              preco: body.price,
              status: body.status,
              atualizado_em: new Date().toISOString()
            }, { onConflict: 'cliente_id,ml_item_id,variacao_id' });
            total++;
          }
        }
      }

      offset += limit;
      if (offset >= listRes.data.paging.total) break;
    }

    await supabase.from('config').upsert({
      chave: `ultima_sync_${cliente.id}`,
      valor: new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    });

    console.log(`[AUTO-SYNC] ${cliente.nome_loja}: ${total} anuncios sincronizados`);
  } catch (err) {
    console.error(`[AUTO-SYNC] Erro em ${cliente.nome_loja}:`, err.message);
  }
}

async function sincronizacaoAutomatica() {
  console.log('[AUTO-SYNC] Iniciando sincronizacao automatica...');
  try {
    const { data: clientes } = await supabase
      .from('clientes')
      .select('*')
      .eq('ativo', true);
    if (!clientes || !clientes.length) return;
    for (const cliente of clientes) {
      await sincronizarCliente(cliente);
    }
    console.log('[AUTO-SYNC] Concluida para todos os clientes.');
  } catch (err) {
    console.error('[AUTO-SYNC] Erro geral:', err.message);
  }
}

// Rota para ver status da ultima sincronizacao
app.get('/sync-status', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('config')
    .select('valor')
    .eq('chave', `ultima_sync_${req.cliente.id}`)
    .single();
  res.json({ ultima_sync: data?.valor || null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Horizon Estoque API rodando na porta ${PORT}`);
  // Sincroniza ao iniciar e depois a cada 6 horas
  sincronizacaoAutomatica();
  setInterval(sincronizacaoAutomatica, 6 * 60 * 60 * 1000);
});
