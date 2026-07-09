require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');

const shop = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ADMIN_API_TOKEN;

const query = `{
  page(id: "gid://shopify/Page/122995507379") {
    title
    body
  }
}`;

const body = JSON.stringify({ query });

const options = {
  hostname: shop,
  path: '/admin/api/2024-10/graphql.json',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    if (json.data && json.data.page) {
      console.log('Title:', json.data.page.title);
      console.log('Body:', json.data.page.body.substring(0, 500));
    } else if (json.errors) {
      console.log('Errors:', JSON.stringify(json.errors).substring(0, 500));
    } else {
      console.log('Response:', data.substring(0, 500));
    }
  });
});
req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();
