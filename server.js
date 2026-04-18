const express = require('express');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const cookieParser = require('cookie-parser');
const path = require('path');

// Carrega variáveis de ambiente (opcional, não quebra se o arquivo .env não existir)
try {
  require('dotenv').config();
} catch (e) {
  console.log('Aviso: dotenv não carregado, usando variáveis de ambiente do sistema.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || '133622'; // ID da sua campanha no ajudaja.com.br

// Middleware para CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie'); // Adicionado Cookie
  res.setHeader('Access-Control-Allow-Credentials', 'true'); // Permite credenciais (cookies)
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json()); // Para parsear JSON do corpo da requisição
app.use(express.urlencoded({ extended: true })); // Para parsear URL-encoded do corpo da requisição
app.use(cookieParser()); // Para parsear cookies

// Configuração do Axios para manter cookies entre as requisições
const axiosInstance = axios.create({
  baseURL: 'https://ajudaja.com.br',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://ajudaja.com.br',
    'X-Requested-With': 'XMLHttpRequest',
  },
  withCredentials: true, // Importante para enviar e receber cookies
});

// Interceptor para salvar cookies da resposta
axiosInstance.interceptors.response.use(response => {
  const setCookieHeader = response.headers['set-cookie'];
  if (setCookieHeader) {
    const cookies = setCookieHeader.map(cookie => cookie.split(';')[0]).join('; ');
    response.config.headers['Cookie'] = cookies; // Atualiza o header 'Cookie' para futuras requisições
  }
  return response;
}, error => {
  return Promise.reject(error);
});

// Rota do Proxy PIX
app.post('/proxy/pix', async (req, res, next) => {
  try {
    console.log('--- Nova requisição PIX recebida ---');
    const { payer_name, payer_email, amount } = req.body;

    if (!payer_name || !amount) {
      return res.status(400).json({ error: 'Nome do pagador e valor são obrigatórios.' });
    }

    console.log('Parâmetros recebidos:', { campaign_id: CAMPAIGN_ID, payer_name, amount });

    const postData = new URLSearchParams({
      campaign_id: CAMPAIGN_ID,
      payer_name: payer_name,
      payer_email: payer_email || 'nao@informado.com',
      msg: '',
      amount: amount,
    }).toString();

    console.log('Passo 1: Solicitando pagamento ao ajudaja...');
    const ajudajaResponse = await axiosInstance.post('/ajudar/ajax_payment_pix.php', postData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}`,
      },
      timeout: 30000, // 30 segundos de timeout
    });

    if (ajudajaResponse.status !== 200) {
      console.error('Erro na API do ajudaja. Status:', ajudajaResponse.status, 'Body:', ajudajaResponse.data);
      return res.status(502).json({ error: 'Falha na comunicação com o provedor de pagamento', status: ajudajaResponse.status, details: ajudajaResponse.data });
    }

    const ajudajaData = ajudajaResponse.data;

    if (ajudajaData.status !== 'ok' || !ajudajaData.url) {
      console.warn('Ajudaja retornou erro ou URL ausente:', JSON.stringify(ajudajaData).substring(0, 200));
      return res.status(400).json({ error: 'O provedor recusou a geração do PIX', details: ajudajaData });
    }

    console.log('Passo 2: Buscando código PIX na página:', ajudajaData.url);
    const pixPageResponse = await axiosInstance.get(`/ajudar/${ajudajaData.url}`, {
      headers: {
        'Referer': `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}`,
      },
      timeout: 30000, // 30 segundos de timeout
    });

    const pixHtml = pixPageResponse.data;
    let pixCode = null;

    // Tenta extrair usando Cheerio (mais robusto)
    const $ = cheerio.load(pixHtml);
    pixCode = $('input[id^="qr_code_text_"]').val() || $('input[value^="0002"]').val();

    // Fallback para Regex se Cheerio não encontrar (menos provável com seletores mais abrangentes)
    if (!pixCode) {
      const match1 = pixHtml.match(/id="qr_code_text_[^"]*".*?value="([^"]+)"/);
      const match2 = pixHtml.match(/value="(0002[^"]+)"/);
      pixCode = (match1 ? match1[1] : null) || (match2 ? match2[1] : null);
    }

    if (!pixCode) {
      console.error('Não foi possível localizar o código PIX no HTML retornado. Início do HTML:', pixHtml.substring(0, 500));
      return res.status(500).json({ error: 'Erro ao extrair o código PIX da página de destino', html_snippet: pixHtml.substring(0, 500) });
    }

    console.log('PIX extraído com sucesso!');
    res.status(200).json({ success: true, pixCode: pixCode });

  } catch (err) {
    console.error('Erro crítico no processamento do proxy:', err.message, err.stack);
    // Verifica se é um erro do Axios para fornecer mais detalhes
    if (axios.isAxiosError(err)) {
      console.error('Detalhes do erro Axios:', err.response?.status, err.response?.data);
      return res.status(err.response?.status || 500).json({
        error: 'Erro na comunicação externa',
        message: err.message,
        details: err.response?.data || err.toJSON(),
      });
    } else {
      return res.status(500).json({ error: 'Erro interno no servidor proxy', message: err.message, stack: err.stack });
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public'))); // Assumindo que arquivos estáticos estão em uma pasta 'public'

// Fallback para SPA (Single Page Application) - serve index.html para qualquer rota não encontrada
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware de tratamento de erros final
app.use((err, req, res, next) => {
  console.error('Erro não capturado:', err.stack);
  res.status(500).json({ error: 'Erro interno do servidor', message: err.message });
});

app.listen(PORT, () => {
  console.log(`Servidor de Checkout rodando na porta ${PORT}`);
});
