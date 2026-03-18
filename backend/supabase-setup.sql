-- Execute este SQL no Supabase > SQL Editor

-- Tabela de clientes (lojas)
CREATE TABLE clientes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome_loja TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ativo BOOLEAN DEFAULT true,
  dispositivos_max INTEGER DEFAULT 2,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela de anúncios do ML
CREATE TABLE anuncios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES clientes(id) ON DELETE CASCADE,
  ml_item_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  ean TEXT,
  estoque INTEGER DEFAULT 0,
  preco DECIMAL(10,2),
  status TEXT DEFAULT 'active',
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cliente_id, ml_item_id)
);

-- Tabela de baixas (histórico)
CREATE TABLE baixas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES clientes(id) ON DELETE CASCADE,
  anuncio_id UUID REFERENCES anuncios(id) ON DELETE SET NULL,
  produto_nome TEXT NOT NULL,
  ean TEXT,
  quantidade INTEGER NOT NULL,
  estoque_antes INTEGER NOT NULL,
  estoque_depois INTEGER NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX idx_anuncios_ean ON anuncios(cliente_id, ean);
CREATE INDEX idx_anuncios_ml ON anuncios(cliente_id, ml_item_id);
CREATE INDEX idx_baixas_cliente ON baixas(cliente_id, criado_em DESC);

-- Inserir a Rainha dos Calçados como primeiro cliente
INSERT INTO clientes (nome_loja, token, ativo, dispositivos_max)
VALUES ('Rainha dos Calçados', 'RAINHA-2025-RC1', true, 2);
