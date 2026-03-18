# Horizon Consultoria · Sistema de Baixa de Estoque ML
## Guia de Deploy Completo (Custo Zero)

---

## Estrutura do Projeto

```
horizon-estoque/
├── backend/
│   ├── server.js           ← API Node.js
│   ├── package.json
│   ├── supabase-setup.sql  ← Execute no Supabase
│   └── .env.example        ← Variáveis de ambiente
├── frontend-cliente/
│   └── index.html          ← Painel da Rainha dos Calçados
└── frontend-admin/
    └── index.html          ← Painel da Horizon Consultoria
```

---

## PASSO 1 — Criar conta no GitHub e subir o código

1. Acesse github.com e crie uma conta gratuita
2. Crie um repositório chamado `horizon-estoque`
3. Faça upload das 3 pastas (backend, frontend-cliente, frontend-admin)

---

## PASSO 2 — Configurar o Supabase (banco de dados)

1. Acesse supabase.com e crie uma conta gratuita
2. Clique em "New project" → defina nome e senha
3. Vá em "SQL Editor" → clique em "New query"
4. Cole o conteúdo do arquivo `supabase-setup.sql` e execute
5. Vá em "Project Settings" → "API":
   - Copie a **Project URL** → será o SUPABASE_URL
   - Copie a **anon public key** → será o SUPABASE_KEY

---

## PASSO 3 — Deploy do Backend no Render

1. Acesse render.com e crie uma conta gratuita
2. Clique em "New +" → "Web Service"
3. Conecte ao repositório GitHub que criou
4. Configure:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Na aba "Environment", adicione as variáveis:
   ```
   ML_CLIENT_ID        = seu client_id do ML
   ML_CLIENT_SECRET    = seu client_secret do ML
   ML_REFRESH_TOKEN    = seu refresh_token do ML
   SUPABASE_URL        = (copiado no passo 2)
   SUPABASE_KEY        = (copiado no passo 2)
   ADMIN_KEY           = horizon-admin-2025
   ```
6. Clique em "Create Web Service"
7. Anote a URL gerada (formato: https://horizon-estoque-xxxx.onrender.com)

---

## PASSO 4 — Configurar o UptimeRobot (evita o servidor dormir)

1. Acesse uptimerobot.com e crie conta gratuita
2. Clique em "Add New Monitor"
3. Tipo: HTTP(s)
4. URL: https://SEU-PROJETO.onrender.com/ping
5. Intervalo: 5 minutos
6. Salvar — pronto!

---

## PASSO 5 — Atualizar a URL do backend nos frontends

Nos arquivos `frontend-cliente/index.html` e `frontend-admin/index.html`,
localize a linha:
```js
const API = 'https://SEU-PROJETO.onrender.com';
```
E substitua pela URL real do Render.

---

## PASSO 6 — Deploy dos Frontends no Vercel

### Frontend do Cliente (Rainha dos Calçados)
1. Acesse vercel.com e crie conta gratuita
2. "Add New Project" → importe o repositório
3. **Root Directory:** `frontend-cliente`
4. Deploy!
5. URL gerada: https://rainha-estoque.vercel.app

### Frontend Admin (Horizon Consultoria)
1. Repita o processo
2. **Root Directory:** `frontend-admin`
3. URL gerada: https://horizon-admin.vercel.app

---

## PASSO 7 — Primeiro acesso

### Painel Admin (Horizon)
- URL: https://horizon-admin.vercel.app
- Chave: `horizon-admin-2025`

### Painel do Cliente (Rainha dos Calçados)
- URL: https://rainha-estoque.vercel.app
- Código: `RAINHA-2025-RC1`
- Após entrar, clique em "Atualizar" para sincronizar os anúncios do ML

---

## Custos Mensais

| Serviço        | Plano  | Custo     |
|---------------|--------|-----------|
| Render.com    | Free   | R$ 0,00   |
| Supabase      | Free   | R$ 0,00   |
| Vercel        | Free   | R$ 0,00   |
| UptimeRobot   | Free   | R$ 0,00   |
| **Total**     |        | **R$ 0,00** |

Opcional: domínio próprio (ex: estoque.rainhadoscalcados.com.br) ≈ R$ 40/ano

---

## Suporte

Horizon Consultoria
