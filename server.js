const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

// Add stealth plugin and use it
chromium.use(stealth());

const app = express();
app.use(express.json());

// In-memory job storage (use Redis in production)
const jobs = new Map();

const runScraper = async (jobId, originUrl, maxPages = 1) => {
  console.log(`🚀 Job ${jobId}: Starting scrape for: ${originUrl}`);

  // Update job status
  jobs.set(jobId, { status: 'running', progress: 0, data: [], error: null });

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
      console.log(`📄 Job ${jobId}: Scraping page ${i}/${maxPages}...`);

      // Update progress
      jobs.set(jobId, {
        status: 'running',
        progress: Math.round((i / maxPages) * 100),
        currentPage: i,
        totalPages: maxPages,
        data: [],
        error: null
      });

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
          await page.waitForTimeout(1500); // Wait for page load
        } else {
          console.log(`🏁 Job ${jobId}: No more pages at page ${i}.`);
          break;
        }
      }
    }

    // Deduplicate
    const uniqueListings = [...new Map(allListings.map(item => [item.link, item])).values()];

    // Mark job as complete
    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      count: uniqueListings.length,
      data: uniqueListings,
      error: null,
      completedAt: new Date().toISOString()
    });

    console.log(`✅ Job ${jobId}: Completed with ${uniqueListings.length} listings`);

  } catch (error) {
    console.error(`❌ Job ${jobId}: Error:`, error.message);
    jobs.set(jobId, {
      status: 'failed',
      progress: 0,
      data: [],
      error: error.message
    });
  } finally {
    await browser.close();
  }
};

// Generate simple job ID
const generateJobId = () => `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// ============== API ENDPOINTS ==============

// Start a new scrape job (returns immediately with job ID)
app.post('/scrape', async (req, res) => {
  const { originUrl, limit_pages } = req.body;

  if (!originUrl) {
    return res.status(400).json({ error: 'Missing originUrl' });
  }

  const jobId = generateJobId();
  const maxPages = limit_pages || 1;

  // Initialize job
  jobs.set(jobId, { status: 'queued', progress: 0, data: [], error: null });

  // Start scraping in background (don't await!)
  runScraper(jobId, originUrl, maxPages);

  // Return immediately with job ID
  res.json({
    success: true,
    message: 'Scraping job started',
    jobId: jobId,
    checkStatusUrl: `/job/${jobId}`,
    tip: `Poll GET /job/${jobId} to check progress`
  });
});

// Check job status
app.get('/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // If job is still running, don't send data yet
  if (job.status === 'running' || job.status === 'queued') {
    return res.json({
      jobId,
      status: job.status,
      progress: job.progress,
      currentPage: job.currentPage,
      totalPages: job.totalPages
    });
  }

  // If completed or failed, send full result
  res.json({
    jobId,
    status: job.status,
    progress: job.progress,
    count: job.count || 0,
    data: job.data,
    error: job.error,
    completedAt: job.completedAt
  });
});

// List all jobs
app.get('/jobs', (req, res) => {
  const allJobs = [];
  jobs.forEach((job, id) => {
    allJobs.push({ jobId: id, status: job.status, progress: job.progress });
  });
  res.json({ jobs: allJobs });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Railway Port Binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Scraper API listening on port ${PORT}`);
  console.log(`📋 Endpoints:`);
  console.log(`   POST /scrape - Start a scraping job`);
  console.log(`   GET  /job/:jobId - Check job status`);
  console.log(`   GET  /jobs - List all jobs`);
  console.log(`   GET  /health - Health check`);
});
