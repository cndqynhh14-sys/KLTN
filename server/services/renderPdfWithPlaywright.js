const fs = require('fs');
const { chromium } = require('playwright');
const logger = require('../logger');

async function launchBrowser() {
  const launchOptions = { headless: true };
  try {
    return await chromium.launch(launchOptions);
  } catch (firstError) {
    const channels = ['chrome', 'msedge'];
    for (const channel of channels) {
      try {
        return await chromium.launch({ ...launchOptions, channel });
      } catch {}
    }
    throw firstError;
  }
}

async function main() {
  const [, , htmlPath, pdfPath] = process.argv;
  if (!htmlPath || !pdfPath) {
    throw new Error('usage: node renderPdfWithPlaywright.js <htmlPath> <pdfPath>');
  }

  const html = htmlPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(htmlPath, 'utf8');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
    });
    if (pdfPath === '-') process.stdout.write(pdf);
    else fs.writeFileSync(pdfPath, pdf);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  logger.error(error.stack || error.message);
  process.exit(1);
});
