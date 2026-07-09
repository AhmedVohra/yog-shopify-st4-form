const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'data', 'demo.pdf');

(async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Test PDF for Signing Demo', { x: 50, y: 800, size: 18, font, color: rgb(0, 0, 0) });
  page.drawText('This is a test document for the Shopify integration.', { x: 50, y: 770, size: 12, font, color: rgb(0, 0, 0) });
  fs.writeFileSync(OUT_FILE, await doc.save());
  console.log('Demo PDF created:', OUT_FILE);
})();
