const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'Customer Application 1.pdf');
const OUT = path.join(__dirname, '..', 'data', 'customer-application-page3.pdf');

(async () => {
  const srcDoc = await PDFDocument.load(fs.readFileSync(SRC));
  const outDoc = await PDFDocument.create();
  const [page3] = await outDoc.copyPages(srcDoc, [2]); // 0-indexed: page 3
  outDoc.addPage(page3);
  fs.writeFileSync(OUT, await outDoc.save());
  console.log('Extracted:', OUT);
})();
