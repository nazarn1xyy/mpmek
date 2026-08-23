const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3847;
const APP_DIR = path.join(__dirname, 'app');
const API_DIR = path.join(__dirname, 'api');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 1. Mock Vercel Insights on localhost
    if (pathname === '/_vercel/insights/script.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end('// Vercel Insights local stub');
    }

    // 2. Serverless API routing: /api/*
    if (pathname.startsWith('/api/')) {
        const apiName = pathname.replace('/api/', '').split('?')[0];
        const apiPath = path.join(API_DIR, `${apiName}.js`);
        const subApiPath = path.join(API_DIR, `${apiName}/index.js`);

        let targetFile = null;
        if (fs.existsSync(apiPath)) targetFile = apiPath;
        else if (fs.existsSync(subApiPath)) targetFile = subApiPath;

        if (targetFile) {
            try {
                let bodyData = '';
                req.on('data', chunk => { bodyData += chunk; });
                req.on('end', async () => {
                    req.query = parsedUrl.query;
                    try {
                        req.body = bodyData ? JSON.parse(bodyData) : {};
                    } catch {
                        req.body = bodyData;
                    }

                    res.status = (code) => {
                        res.statusCode = code;
                        return res;
                    };
                    res.json = (data) => {
                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                        res.end(JSON.stringify(data));
                        return res;
                    };

                    delete require.cache[require.resolve(targetFile)];
                    const handler = require(targetFile);
                    await handler(req, res);
                });
                return;
            } catch (err) {
                console.error(`API Error on ${pathname}:`, err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'API endpoint not found' }));
        }
    }

    // 3. Static Files from app/
    let filePath = path.join(APP_DIR, pathname === '/' ? 'index.html' : pathname);
    
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Development server running at http://localhost:${PORT}`);
});
