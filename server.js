require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
app.use(cors({ origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:3003", "https://avoid-payday-litter.ngrok-free.dev"], credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "ml-agentes-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000, sameSite: "lax" }
}));

app.get("/auth/login", (req, res) => {
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${encodeURIComponent(process.env.ML_REDIRECT_URI)}`;
  res.json({ url });
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { data } = await axios.post("https://api.mercadolibre.com/oauth/token", null, {
      params: { grant_type: "authorization_code", client_id: process.env.ML_APP_ID, client_secret: process.env.ML_CLIENT_SECRET, code, redirect_uri: process.env.ML_REDIRECT_URI }
    });
    req.session.mlToken = data.access_token;
    req.session.mlRefresh = data.refresh_token;
    req.session.mlUserId = data.user_id;
    res.redirect(process.env.FRONTEND_URL + "/dashboard");
  } catch (e) {
    res.redirect(process.env.FRONTEND_URL + "/?erro=auth");
  }
});
app.get("/auth/status", (req, res) => {
  res.json({ conectado: !!req.session.mlToken, userId: req.session.mlUserId || null });
});

app.post("/auth/logout", (req, res) => { req.session.destroy(); res.json({ ok: true }); });

async function ml(req, method, path, data) {
  const token = req.session.mlToken;
  if (!token) throw new Error("Não autenticado");
  const r = await axios({ method, url: `https://api.mercadolibre.com${path}`, data, headers: { Authorization: `Bearer ${token}` } });
  return r.data;
}

app.get("/anuncios", async (req, res) => {
  try {
    const { offset = 0 } = req.query;
    const result = await ml(req, "get", `/users/${req.session.mlUserId}/items/search?offset=${offset}&limit=20`);
    if (!result.results?.length) return res.json({ items: [], total: 0 });
    const ids = result.results.join(",");
    const items = await ml(req, "get", `/items?ids=${ids}&attributes=id,title,price,status,thumbnail,available_quantity,sold_quantity`);
    res.json({ items: items.map(i => i.body).filter(Boolean), total: result.paging?.total || 0 });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.get("/anuncios/:id", async (req, res) => {
  try {
    const [item, desc, visitas] = await Promise.all([
      ml(req, "get", `/items/${req.params.id}`),
      ml(req, "get", `/items/${req.params.id}/description`).catch(() => ({ plain_text: "" })),
      ml(req, "get", `/items/${req.params.id}/visits/time_window?last=30&unit=day`).catch(() => ({ total_visits: 0 }))
    ]);
    res.json({ ...item, descricao: desc.plain_text, visitas: visitas.total_visits || 0 });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.put("/anuncios/:id", async (req, res) => {
  try {
    const { titulo, preco, descricao } = req.body;
    const att = {};
    if (titulo) att.title = titulo;
    if (preco) att.price = parseFloat(preco);
    if (Object.keys(att).length) await ml(req, "put", `/items/${req.params.id}`, att);
    if (descricao) await ml(req, "put", `/items/${req.params.id}/description`, { plain_text: descricao });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.post("/anuncios", async (req, res) => {
  try { res.json(await ml(req, "post", "/items", req.body)); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.get("/perguntas", async (req, res) => {
  try {
    const data = await ml(req, "get", `/questions/search?seller_id=${req.session.mlUserId}&status=UNANSWERED&limit=20`);
    res.json({ perguntas: data.questions || [] });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.post("/perguntas/:id/responder", async (req, res) => {
  try {
    await ml(req, "post", "/answers", { question_id: parseInt(req.params.id), text: req.body.resposta });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.post("/agente/diagnostico", async (req, res) => {
  const { titulo, descricao, preco, fotos, visitas, vendas, categoria, imagens_base64 } = req.body;
  const conv = visitas > 0 ? ((vendas / visitas) * 100).toFixed(1) + "%" : "não informada";
  const content = [];
  if (imagens_base64?.length) imagens_base64.forEach(img => content.push({ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }));
  content.push({ type: "text", text: `Diagnóstico do anúncio ML:\nTÍTULO: ${titulo}\nDESCRIÇÃO: ${descricao}\nPREÇO: R$ ${preco}\nCATEGORIA: ${categoria}\nFOTOS: ${fotos}\nVISITAS: ${visitas}\nVENDAS: ${vendas}\nCONVERSÃO: ${conv}\n\nAnalise e entregue:\n🔍 DIAGNÓSTICO GERAL (nota 0-10)\n📝 ANÁLISE DO TÍTULO (problemas + título novo)\n📄 ANÁLISE DA DESCRIÇÃO\n📸 ANÁLISE DAS FOTOS\n💰 PREÇO E COMPETITIVIDADE\n📊 INTERPRETAÇÃO DAS MÉTRICAS\n⚠️ ERROS CRÍTICOS\n✅ PLANO DE AÇÃO PRIORIZADO (hoje / semana / mês)` });
  try {
    const msg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, system: "Especialista sênior em e-commerce Mercado Livre Brasil. Diagnósticos honestos, diretos e práticos.", messages: [{ role: "user", content }] });
    res.json({ resultado: msg.content[0].text });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post("/agente/anuncio", async (req, res) => {
  const { produto, descricao, preco, categoria, palavras_chave } = req.body;
  try {
    const msg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, system: "Especialista em anúncios Mercado Livre Brasil. Responda APENAS em JSON válido sem markdown.", messages: [{ role: "user", content: `Produto: ${produto}\nDescrição: ${descricao}\nPreço: R$ ${preco}\nCategoria: ${categoria}\nPalavras-chave: ${palavras_chave}\n\nRetorne JSON:\n{"titulo":"máx 60 chars","titulo_longo":"máx 120 chars","bullet_points":["até 8"],"descricao":"completa","tags":["até 10"],"categoria_sugerida":""}` }] });
    const text = msg.content[0].text.replace(/```json|```/g, "").trim();
    res.json(JSON.parse(text));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post("/agente/imagens", async (req, res) => {
  const { produto, categoria, estilo, diferenciais, funil } = req.body;
  try {
    const msg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, system: "Especialista em prompts para Gemini/Imagen para e-commerce Mercado Livre Brasil.", messages: [{ role: "user", content: `Produto: ${produto}\nCategoria: ${categoria}\nEstilo: ${estilo}\nDiferenciais: ${diferenciais}\n\nCrie prompts em inglês para:\n${funil.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nFormato:\nIMAGEM [N] - [NOME]\nPrompt: [prompt completo]` }] });
    res.json({ prompts: msg.content[0].text });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post("/agente/atendimento", async (req, res) => {
  const { pergunta, produto, info_produto, tom, historico } = req.body;
  const tons = { profissional: "profissional e objetivo", amigavel: "amigável e descontraído", formal: "formal e respeitoso" };
  try {
    const msg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 300, system: `Agente de atendimento de loja no Mercado Livre${produto ? " que vende " + produto : ""}. Tom: ${tons[tom] || "profissional"}. ${info_produto ? "Info: " + info_produto : ""} Máx 3 frases. Não mencione IA.`, messages: [...(historico || []), { role: "user", content: pergunta }] });
    res.json({ resposta: msg.content[0].text });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get("/metricas", async (req, res) => {
  try {
    const [ativos, perguntas] = await Promise.all([
      ml(req, "get", `/users/${req.session.mlUserId}/items/search?status=active`).catch(() => ({ paging: { total: 0 } })),
      ml(req, "get", `/questions/search?seller_id=${req.session.mlUserId}&status=UNANSWERED`).catch(() => ({ paging: { total: 0 } }))
    ]);
    res.json({ anuncios_ativos: ativos.paging?.total || 0, perguntas_pendentes: perguntas.paging?.total || 0 });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.listen(PORT, () => console.log(`\n✅ Backend rodando em http://localhost:${PORT}\n`));
