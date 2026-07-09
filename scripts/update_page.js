require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const shop = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
const pageId = '122995507379';
const apiVersion = '2024-10';

const body = JSON.stringify({
  page: {
    id: pageId,
    body_html: '<p>Fill out and sign your PDF form below. All fields must be completed before submission.</p>\n<p><iframe src="https://legal-days-ring.loca.lt/form?id=d6673d59" width="100%" height="900" style="border: 1px solid #ddd; border-radius: 8px;"></iframe></p>'
  }
});

const options = {
  hostname: shop,
  path: '/admin/api/' + apiVersion + '/pages/' + pageId + '.json',
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
    'Content-Length': Buffer.byteLength(body)
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log('Status:', res.statusCode);
    if (json.page) {
      console.log('Page updated:', json.page.title);
      console.log('Body HTML:', json.page.body_html.substring(0, 300));
    } else {
      console.log('Errors:', JSON.stringify(json.errors || json));
    }
  });
});
req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();
