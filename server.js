const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

// Add stealth plugin and use it
chromium.use(stealth());

const app = express();
app.use(express.json());

const runScraper = async (originUrl, maxPages = 1) => {
  console.log(`🚀 Starting scrape for: ${originUrl}`);
  
  // Launch options optimized for Docker/Railway
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();
  let allListings = [];

  try {
    // 1. Navigate
    await page.goto(originUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
    
    // Loop through pages
    for (let i = 1; i <= maxPages; i++) {
      console.log(`📄 Scraping page ${i}...`);
      
      // Wait for listings to settle
      try {
        await page.waitForSelector('a', { timeout: 5000 });
      } catch (e) {
        console.log("⚠️ No specific selector found, proceeding anyway...");
      }
      await page.waitForTimeout(2000); 

      // 2. The "Human Eye" Extraction Logic
      const pageListings = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.map(link => {
          const text = link.innerText;
          // Look for price-like numbers (e.g., 300,000)
          const priceMatch = text.match(/[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?/);
          
          // Filter out junk
          if (text.includes('عقارات في') || !priceMatch) return null;

          return {
            title: link.querySelector('h3, h4')?.innerText || text.split('\n')[0].substring(0, 100),
            price: priceMatch[0],
            // Try to find area (number followed by m²)
            area: text.match(/([0-9]+)\s*م²/)?.[1] || 'N/A', 
            link: link.href
          };
        }).filter(item => item !== null);
      });

      // Add to master list
      allListings.push(...pageListings);

      // 3. Pagination (Next Button)
      if (i < maxPages) {
        // Look for the "»" button or "Next"
        const nextBtn = page.getByRole('button', { name: '»' }).first();
        if (await nextBtn.isVisible()) {
          await nextBtn.click();
        } else {
          console.log('🏁 No more pages.');
          break;
        }
      }
    }

    // Deduplicate
    const uniqueListings = [...new Map(allListings.map(item => [item.link, item])).values()];
    return uniqueListings;

  } catch (error) {
    console.error("❌ Scrape Error:", error);
    throw error;
  } finally {
    await browser.close();
  }
};

// The API Endpoint
app.post('/scrape', async (req, res) => {
  const { originUrl, limit_pages } = req.body;

  if (!originUrl) {
    return res.status(400).json({ error: 'Missing originUrl' });
  }

  try {
    const data = await runScraper(originUrl, limit_pages || 1);
    res.json({ 
      success: true, 
      count: data.length, 
      data: data 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Railway Port Binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Scraper API listening on port ${PORT}`);
});
