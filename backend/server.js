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
  await supabase.from('config').upsert({
    chave: 'ml_refresh_token',
    valor: token,
    atualizado_em: new Date().toISOString()
  });
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
    if (res.data.refresh_token) await saveRefreshToken(res.data.refresh_token);
    return mlAccessToken;
  } catch (err) {
    const errData = err.response?.data;
    const errStatus = err.response?.status;
    console.error('ML AUTH ERROR:', errStatus, JSON.stringify(errData));
    throw new Error('Falha na autenticacao com Mercado Livre');
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
    for (const variation of body.variations) {
      for (const id of EAN_IDS) {
        const a = (variation.attributes || []).find(x => x.id === id)
               || (variation.attribute_combinations || []).find(x => x.id === id);
        if (a?.values?.[0]?.name) return a.values[0].name;
      }
    }
  }
  return null;
}

async function authMiddleware(req, res, next) {
  const token = req.headers['x-access-token'];
  if (!token) return res.status(401).json({ error: 'Token nao fornecido' });
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .eq('token', token)
    .single();
  if (error || !data) return res.status(401).json({ error: 'Token invalido' });
  if (!data.ativo) return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com a Horizon Consultoria.' });
  req.cliente = data;
  next();
}

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Nao autorizado' });
  next();
}

// ─── ROTAS CLIENTE ───────────────────────────────────────────

app.post('/auth', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token obrigatorio' });
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nome_loja, token, ativo, dispositivos_max, estoque_minimo_alerta')
    .eq('token', token)
    .single();
  if (error || !data) return res.status(401).json({ error: 'Codigo de acesso invalido' });
  if (!data.ativo) return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com a Horizon Consultoria.' });
  res.json({ ok: true, loja: data.nome_loja, clienteId: data.id, estoqueMinimo: data.estoque_minimo_alerta || 3 });
});

app.get('/anuncios', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('anuncios')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .order('nome');
  if (error) return res.status(500).json({ error: 'Erro ao buscar anuncios' });
  res.json(data);
});

app.get('/produto/:ean', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('anuncios')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('ean', req.params.ean)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Produto nao encontrado' });
  res.json(data);
});

app.put('/baixa', authMiddleware, async (req, res) => {
  const { ean, quantidade } = req.body;
  if (!ean || !quantidade || quantidade < 1) {
    return res.status(400).json({ error: 'EAN e quantidade sao obrigatorios' });
  }
  const { data: produto, error: prodErr } = await supabase
    .from('anuncios')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('ean', ean)
    .single();

  if (prodErr || !produto) {
    // EAN nao encontrado — salvar como desconhecido
    await supabase.from('eans_desconhecidos').upsert({
      cliente_id: req.cliente.id,
      ean: ean,
      quantidade_tentativas: 1,
      atualizado_em: new Date().toISOString()
    }, { onConflict: 'cliente_id,ean', ignoreDuplicates: false });

    // Incrementar contador se ja existe
    await supabase.rpc('incrementar_tentativas_ean', { p_cliente_id: req.cliente.id, p_ean: ean }).catch(() => {});

    return res.status(404).json({ error: 'Produto nao encontrado nos anuncios', tipo: 'ean_desconhecido' });
  }

  if (produto.estoque < quantidade) {
    return res.status(400).json({ error: `Estoque insuficiente. Disponivel: ${produto.estoque}` });
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
    // Falha na comunicacao com ML — salvar na fila de pendentes
    await supabase.from('pendentes').insert({
      cliente_id: req.cliente.id,
      ean: produto.ean,
      produto_nome: produto.nome,
      variacao_nome: produto.variacao_nome,
      quantidade,
      motivo_falha: err.message || 'Erro de conexao com Mercado Livre',
      tentativas: 1,
      resolvido: false,
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    });
    return res.status(503).json({ error: 'Falha na conexao com ML. Baixa salva na fila de pendentes.', tipo: 'pendente' });
  }

  await supabase
    .from('anuncios')
    .update({ estoque: novoEstoque, atualizado_em: new Date().toISOString() })
    .eq('id', produto.id);

  const { data: baixaInserida } = await supabase.from('baixas').insert({
    cliente_id: req.cliente.id,
    anuncio_id: produto.id,
    produto_nome: produto.nome,
    ean: produto.ean,
    quantidade,
    estoque_antes: produto.estoque,
    estoque_depois: novoEstoque,
    criado_em: new Date().toISOString()
  }).select().single();

  res.json({
    ok: true,
    baixa_id: baixaInserida?.id,
    produto: produto.nome,
    variacao: produto.variacao_nome,
    estoque_anterior: produto.estoque,
    estoque_novo: novoEstoque,
    quantidade_baixada: quantidade,
    alerta_estoque_baixo: novoEstoque <= (req.cliente.estoque_minimo_alerta || 3)
  });
});

// Estorno de baixa
app.delete('/baixa/:id', authMiddleware, async (req, res) => {
  const { data: baixa, error } = await supabase
    .from('baixas')
    .select('*')
    .eq('id', req.params.id)
    .eq('cliente_id', req.cliente.id)
    .single();

  if (error || !baixa) return res.status(404).json({ error: 'Baixa nao encontrada' });

  const diffMin = (Date.now() - new Date(baixa.criado_em).getTime()) / 60000;
  if (diffMin > 60) return res.status(400).json({ error: 'So e possivel estornar baixas das ultimas 60 minutos' });

  try {
    const token = await getMLToken();
    const estoqueRestaurado = baixa.estoque_antes;
    await axios.put(
      `https://api.mercadolibre.com/items/${baixa.anuncio_id}`,
      { available_quantity: estoqueRestaurado },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await supabase.from('anuncios')
      .update({ estoque: estoqueRestaurado, atualizado_em: new Date().toISOString() })
      .eq('id', baixa.anuncio_id);
    await supabase.from('baixas').delete().eq('id', baixa.id);
    res.json({ ok: true, estoque_restaurado: estoqueRestaurado });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao estornar baixa no ML' });
  }
});

// Historico de baixas (7 dias)
app.get('/historico', authMiddleware, async (req, res) => {
  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('baixas')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .gte('criado_em', seteDiasAtras)
    .order('criado_em', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: 'Erro ao buscar historico' });
  res.json(data);
});

// Fila de pendentes
app.get('/pendentes', authMiddleware, async (req, res) => {
  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('pendentes')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('resolvido', false)
    .gte('criado_em', seteDiasAtras)
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: 'Erro ao buscar pendentes' });
  res.json(data);
});

// Reprocessar pendente
app.post('/pendentes/:id/reprocessar', authMiddleware, async (req, res) => {
  const { data: pendente, error } = await supabase
    .from('pendentes')
    .select('*')
    .eq('id', req.params.id)
    .eq('cliente_id', req.cliente.id)
    .single();

  if (error || !pendente) return res.status(404).json({ error: 'Pendente nao encontrado' });

  const { data: produto } = await supabase
    .from('anuncios')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .eq('ean', pendente.ean)
    .single();

  if (!produto) return res.status(404).json({ error: 'Produto nao encontrado. Sincronize os anuncios.' });

  const novoEstoque = Math.max(0, produto.estoque - pendente.quantidade);

  try {
    const token = await getMLToken();
    await axios.put(
      `https://api.mercadolibre.com/items/${produto.ml_item_id}`,
      { available_quantity: novoEstoque },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await supabase.from('anuncios')
      .update({ estoque: novoEstoque, atualizado_em: new Date().toISOString() })
      .eq('id', produto.id);
    await supabase.from('baixas').insert({
      cliente_id: req.cliente.id,
      anuncio_id: produto.id,
      produto_nome: produto.nome,
      ean: produto.ean,
      quantidade: pendente.quantidade,
      estoque_antes: produto.estoque,
      estoque_depois: novoEstoque,
      criado_em: new Date().toISOString()
    });
    await supabase.from('pendentes')
      .update({ resolvido: true, atualizado_em: new Date().toISOString() })
      .eq('id', pendente.id);
    res.json({ ok: true, produto: produto.nome, estoque_novo: novoEstoque });
  } catch (err) {
    await supabase.from('pendentes')
      .update({ tentativas: (pendente.tentativas || 1) + 1, atualizado_em: new Date().toISOString() })
      .eq('id', pendente.id);
    res.status(503).json({ error: 'Falha ao reprocessar. Tente novamente mais tarde.' });
  }
});

// Deletar pendente manualmente
app.delete('/pendentes/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('pendentes')
    .delete()
    .eq('id', req.params.id)
    .eq('cliente_id', req.cliente.id);
  if (error) return res.status(500).json({ error: 'Erro ao deletar pendente' });
  res.json({ ok: true });
});

// EANs desconhecidos
app.get('/eans-desconhecidos', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('eans_desconhecidos')
    .select('*')
    .eq('cliente_id', req.cliente.id)
    .order('quantidade_tentativas', { ascending: false });
  if (error) return res.status(500).json({ error: 'Erro ao buscar EANs' });
  res.json(data);
});

app.delete('/eans-desconhecidos/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('eans_desconhecidos')
    .delete()
    .eq('id', req.params.id)
    .eq('cliente_id', req.cliente.id);
  if (error) return res.status(500).json({ error: 'Erro ao deletar EAN' });
  res.json({ ok: true });
});

// Status da ultima sync
app.get('/sync-status', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('config')
    .select('valor')
    .eq('chave', `ultima_sync_${req.cliente.id}`)
    .single();
  res.json({ ultima_sync: data?.valor || null });
});

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
      await supabase.from('anuncios').upsert(anuncio, { onConflict: 'cliente_id,ml_item_id,variacao_id' });
    }

    await supabase.from('config').upsert({
      chave: `ultima_sync_${req.cliente.id}`,
      valor: new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    });

    res.json({ ok: true, total: todos.length, mensagem: `${todos.length} anuncios sincronizados` });
  } catch (err) {
    console.error('SYNC ERROR:', err.message, JSON.stringify(err.response?.data));
    res.status(500).json({ error: 'Erro ao sincronizar anuncios' });
  }
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
  const { nome_loja, token, dispositivos_max, data_vencimento } = req.body;
  if (!nome_loja || !token) return res.status(400).json({ error: 'Nome e token obrigatorios' });
  const { data, error } = await supabase
    .from('clientes')
    .insert({
      nome_loja, token,
      dispositivos_max: dispositivos_max || 2,
      ativo: true,
      data_vencimento: data_vencimento || null,
      criado_em: new Date().toISOString()
    })
    .select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.put('/admin/clientes/:id', adminAuth, async (req, res) => {
  const { ativo, data_vencimento, estoque_minimo_alerta } = req.body;
  const updates = {};
  if (ativo !== undefined) updates.ativo = ativo;
  if (data_vencimento !== undefined) updates.data_vencimento = data_vencimento;
  if (estoque_minimo_alerta !== undefined) updates.estoque_minimo_alerta = estoque_minimo_alerta;
  const { data, error } = await supabase
    .from('clientes')
    .update(updates)
    .eq('id', req.params.id)
    .select().single();
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

app.get('/admin/resumo', adminAuth, async (req, res) => {
  const inicioMes = new Date();
  inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);

  const { data: clientes } = await supabase.from('clientes').select('*');
  const { data: baixasMes } = await supabase.from('baixas')
    .select('cliente_id, id')
    .gte('criado_em', inicioMes.toISOString());
  const { data: pendentes } = await supabase.from('pendentes')
    .select('cliente_id, id')
    .eq('resolvido', false);
  const { data: eans } = await supabase.from('eans_desconhecidos').select('cliente_id, id');

  const resumo = (clientes || []).map(c => ({
    ...c,
    baixas_mes: (baixasMes || []).filter(b => b.cliente_id === c.id).length,
    falhas_pendentes: (pendentes || []).filter(p => p.cliente_id === c.id).length,
    eans_desconhecidos: (eans || []).filter(e => e.cliente_id === c.id).length
  }));

  res.json(resumo);
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── SINCRONIZACAO AUTOMATICA ─────────────────────────────────

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
    const { data: clientes } = await supabase.from('clientes').select('*').eq('ativo', true);
    if (!clientes || !clientes.length) return;
    for (const cliente of clientes) await sincronizarCliente(cliente);
    console.log('[AUTO-SYNC] Concluida para todos os clientes.');
  } catch (err) {
    console.error('[AUTO-SYNC] Erro geral:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Horizon Estoque API rodando na porta ${PORT}`);
  sincronizacaoAutomatica();
  setInterval(sincronizacaoAutomatica, 6 * 60 * 60 * 1000);
});
