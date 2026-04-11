const http = require('http');
const https = require('https');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURAÇÕES FIXAS ====================
const CAMPAIGN_ID = '104552'; // ID da sua campanha no ajudaja.com.br
// =============================================================

const PORT = process.env.PORT || 3000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', (err) => {
      console.error('Request Error:', err.message);
      reject(err);
    });
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === '/proxy/pix' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        console.log('--- Nova requisição PIX recebida ---');
        const params = JSON.parse(body);
        console.log('Parâmetros:', { campaign_id: CAMPAIGN_ID, payer_name: params.payer_name, amount: params.amount });

        const postData = querystring.stringify({
          campaign_id: CAMPAIGN_ID,
          payer_name: params.payer_name,
          payer_email: params.payer_email || 'nao@informado.com',
          msg: '',
          amount: params.amount,
        });

        console.log('Passo 1: Enviando dados para ajudaja...');
        const ajudajaResponse = await makeRequest({
          hostname: 'ajudaja.com.br',
          path: '/ajudar/ajax_payment_pix.php',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'Referer': `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}`,
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Origin': 'https://ajudaja.com.br',
            'Accept': 'application/json, text/javascript, */*; q=0.01'
          },
        }, postData);

        let ajudajaData;
        try {
          ajudajaData = JSON.parse(ajudajaResponse.body);
        } catch (e) {
          console.error('Erro ao parsear JSON do ajudaja:', ajudajaResponse.body);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Resposta inválida do ajudaja', raw: ajudajaResponse.body }));
          return;
        }

        if (ajudajaData.status !== 'ok') {
          console.warn('Ajudaja retornou erro:', ajudajaData);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ajudaja retornou erro', data: ajudajaData }));
          return;
        }

        console.log('Passo 2: Buscando página do QR Code:', ajudajaData.url);
        const pixPageResponse = await makeRequest({
          hostname: 'ajudaja.com.br',
          path: `/ajudar/${ajudajaData.url}`,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}`,
          },
        });

        const pixHtml = pixPageResponse.body;
        const match = pixHtml.match(/id="qr_code_text_[^"]*"\s+name="[^"]*"\s+value="([^"]+)"/);
        
        if (!match) {
          const match2 = pixHtml.match(/value="(0002[^"]+)"/);
          if (!match2) {
            console.error('Não foi possível extrair o código PIX do HTML');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Não foi possível extrair o código PIX' }));
            return;
          }
          console.log('PIX extraído com sucesso (padrão 2)');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, pixCode: match2[1] }));
          return;
        }

        console.log('PIX extraído com sucesso (padrão 1)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pixCode: match[1] }));

      } catch (err) {
        console.error('Erro crítico no proxy:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data2);
          }
        });
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Checkout server running on port ${PORT}`);
});
