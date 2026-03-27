const fs = require('fs');
const path = require('path');
const axios = require('axios');
const zlib = require('zlib');
const { parseStringPromise } = require('xml2js');
const cheerio = require('cheerio');

// CONFIG
const BASE_DIR = path.join(__dirname, '../allpoetry');
const PROGRESS_FILE = path.join(__dirname, '../automation/allpoetry-progress.json');
const SITEMAP_INDEX = 'https://allpoetry.com/sitemap.xml';
const LIMIT_PER_RUN = 75; // Number of poems to scrape per session
const BATCH_WAIT_MIN = 8000; // 8s
const BATCH_WAIT_MAX = 18000; // 18s

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0'
];

if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(text) {
  return text.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-');
}

async function fetchGzip(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return new Promise((resolve, reject) => {
    zlib.gunzip(response.data, (err, buffer) => {
      if (err) reject(err);
      else resolve(buffer.toString());
    });
  });
}

async function scrapePoem(url) {
  try {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://allpoetry.com/',
        'DNT': '1',
        'Connection': 'keep-alive'
      }
    });

    if (data.includes('unusual traffic from this IP address')) {
      return { status: 'blocked', error: 'IP Blocked' };
    }

    const $ = cheerio.load(data);
    const title = $('.poem_title').text().trim() || $('h1').first().text().trim() || 'Untitled';
    let writer = $('.author_name').text().trim() || $('.author-name').text().trim();
    if (!writer) {
      const match = url.match(/-by-(.*)$/);
      if (match) writer = match[1].replace(/-/g, ' ');
    }
    writer = writer || 'Anonymous';
    const content = $('.poem_body').first().text().trim() || $('.poem-text').text().trim();
    
    if (!content || content.length < 10) return { status: 'skip', error: 'No Content' };

    const writerSlug = slugify(writer);
    const poemSlug = slugify(title);
    const writerDir = path.join(BASE_DIR, writerSlug);
    if (!fs.existsSync(writerDir)) fs.mkdirSync(writerDir, { recursive: true });

    const markdown = `---
title: "${title.replace(/"/g, '\\"')}"
writer: "${writer.replace(/"/g, '\\"')}"
slug: "${poemSlug}"
source: "AllPoetry"
url: "${url}"
---

${content}`;

    fs.writeFileSync(path.join(writerDir, `${poemSlug}.md`), markdown);
    return { status: 'success', writerSlug, poemSlug };
  } catch (e) {
    if (e.response && (e.response.status === 403 || e.response.status === 429)) {
       return { status: 'blocked', error: `HTTP ${e.response.status}` };
    }
    return { status: 'error', error: e.message };
  }
}

async function main() {
  let progress = { last_sitemap_index: 0, last_url_index: 0, total_scraped: 0 };
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE));
  }

  console.log(`[Start] Resuming from Sitemap index ${progress.last_sitemap_index}, URL index ${progress.last_url_index}`);

  try {
    const { data: indexXml } = await axios.get(SITEMAP_INDEX);
    const indexObj = await parseStringPromise(indexXml);
    const sitemaps = indexObj.sitemapindex.sitemap.map(s => s.loc[0]);

    for (let sIdx = progress.last_sitemap_index; sIdx < sitemaps.length; sIdx++) {
      console.log(`[Sitemap] Processing (${sIdx}/${sitemaps.length}): ${sitemaps[sIdx]}`);
      const sitemapXml = await fetchGzip(sitemaps[sIdx]);
      const sitemapObj = await parseStringPromise(sitemapXml);
      const poemUrls = sitemapObj.urlset.url
        .map(u => u.loc[0])
        .filter(url => url.includes('/poem/') || url.includes('/poetry/'));

      console.log(`[Sitemap] Found ${poemUrls.length} potential poems.`);

      let runCount = 0;
      for (let uIdx = progress.last_url_index; uIdx < poemUrls.length; uIdx++) {
        if (runCount >= LIMIT_PER_RUN) {
          console.log(`[Done] Batch limit reached (${LIMIT_PER_RUN}). Saving progress and exiting.`);
          progress.last_run = new Date().toISOString();
          fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
          return;
        }

        const url = poemUrls[uIdx];
        const result = await scrapePoem(url);
        
        if (result.status === 'blocked') {
          console.error(`[FATAL] Blocked by AllPoetry: ${result.error}. Stopping run.`);
          progress.last_run = new Date().toISOString();
          fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
          process.exit(0); // Exit gracefully to allow git commit
        }

        if (result.status === 'success') {
          progress.total_scraped++;
          runCount++;
          console.log(`[Saved] ${result.writerSlug}/${result.poemSlug} (${progress.total_scraped} total)`);
        } else {
          console.warn(`[Skip] ${url}: ${result.error}`);
        }

        progress.last_url_index = uIdx + 1;
        // Periodic save every 5 poems
        if (runCount % 5 === 0) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

        const delay = BATCH_WAIT_MIN + Math.random() * (BATCH_WAIT_MAX - BATCH_WAIT_MIN);
        await sleep(delay);
      }

      // If we finished a whole sitemap
      progress.last_sitemap_index = sIdx + 1;
      progress.last_url_index = 0;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    }
  } catch (e) {
    console.error(`[Fatal] ${e.message}`);
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }
}

main();
