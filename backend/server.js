async function sincronizarCliente(cliente) {
  if (!cliente.ml_autorizado || !cliente.ml_refresh_token) { console.log(`[AUTO-SYNC] ${cliente.nome_loja}: pulado (sem autorizacao ML)`); return; }
  try {
    const mlToken = await getMLTokenCliente(cliente);
    const meRes = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${mlToken}` } });
    const userId = meRes.data.id;
    let offset = 0; const limit = 50; let total = 0;
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

          // Se cliente usa variacoes E o item tem variacoes
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
              await supabase.from('anuncios').upsert({ cliente_id: cliente.id, ml_item_id: body.id, variacao_id: String(variation.id), variacao_nome: nomeAttr?.values?.[0]?.name || `Var ${variation.id}`, nome: body.title, ean: eanVar, estoque: variation.available_quantity || 0, preco: body.price, status: body.status, atualizado_em: new Date().toISOString() }, { onConflict: 'cliente_id,ml_item_id,variacao_id' });
              total++;
            }
          } else {
            // Sem variacao — 1 linha por anuncio
            await supabase.from('anuncios').upsert({ cliente_id: cliente.id, ml_item_id: body.id, variacao_id: null, variacao_nome: null, nome: body.title, ean: extrairEAN(body), estoque: body.available_quantity, preco: body.price, status: body.status, atualizado_em: new Date().toISOString() }, { onConflict: 'cliente_id,ml_item_id,variacao_id' });
            total++;
          }
        }
      }
      offset += limit;
      if (offset >= listRes.data.paging.total) break;
    }
    await supabase.from('config').upsert({ chave: `ultima_sync_${cliente.id}`, valor: new Date().toISOString(), atualizado_em: new Date().toISOString() });
    console.log(`[AUTO-SYNC] ${cliente.nome_loja}: ${total} anuncios`);
  } catch (err) { console.error(`[AUTO-SYNC] Erro em ${cliente.nome_loja}:`, err.message); }
}
