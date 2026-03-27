const fs = require('fs');
const path = require('path');
const axios = require('axios');
const zlib = require('zlib');
const { parseStringPromise } = require('xml2js');
const cheerio = require('cheerio');

// CONFIG
const BASE_DIR = path.join(__dirname, '../allpoetry');
const PROGRESS_FILE = path.join(__dirname, '../automation/allpoetry-progress.json');
const METADATA_FILE = path.join(__dirname, '../automation/all-poems-metadata.json');
const SITEMAP_INDEX = 'https://allpoetry.com/sitemap.xml';
const BATCH_WAIT_MIN = 5000; // 5s reduced for higher throughput
const BATCH_WAIT_MAX = 12000; // 12s

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
      if (err) resolve(null); // Return null on error
      else resolve(buffer.toString());
    });
  });
}

function updateMetadata(poemData) {
  try {
    let metadata = [];
    if (fs.existsSync(METADATA_FILE)) {
      metadata = JSON.parse(fs.readFileSync(METADATA_FILE));
    }
    metadata.push(poemData);
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  } catch (e) {
    console.error(`[Metadata Error] ${e.message}`);
  }
}

async function scrapePoem(url) {
  try {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html',
        'Referer': 'https://allpoetry.com/',
        'DNT': '1'
      }
    });

    if (data.includes('unusual traffic from this IP address') || data.includes('blocked the site from bulk browsing')) {
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

    const filePath = path.join(writerDir, `${poemSlug}.md`);
    if (fs.existsSync(filePath)) return { status: 'skip', error: 'Exists' };

    const markdown = `---
title: "${title.replace(/"/g, '\\"')}"
writer: "${writer.replace(/"/g, '\\"')}"
slug: "${poemSlug}"
source: "AllPoetry"
url: "${url}"
---

${content}`;

    fs.writeFileSync(filePath, markdown);
    updateMetadata({ title, writer, slug: poemSlug, url });
    return { status: 'success', writerSlug, poemSlug };
  } catch (e) {
    if (e.response && (e.response.status === 403 || e.response.status === 429)) {
       return { status: 'blocked', error: `HTTP ${e.response.status}` };
    }
    return { status: 'error', error: e.message };
  }
}

async function main() {
  let progress = { last_sitemap_index: 0, last_url_index: 0, total_scraped: 0, finished: false };
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE));
  }

  if (progress.finished) {
    console.log(`[Task] Scrapping completed forever. Stopping.`);
    process.exit(0);
  }

  console.log(`[Start] Resuming from Sitemap ${progress.last_sitemap_index}, URL ${progress.last_url_index}`);

  try {
    const { data: indexXml } = await axios.get(SITEMAP_INDEX);
    const indexObj = await parseStringPromise(indexXml);
    const sitemaps = indexObj.sitemapindex.sitemap.map(s => s.loc[0]);

    for (let sIdx = progress.last_sitemap_index; sIdx < sitemaps.length; sIdx++) {
      const sitemapUrl = sitemaps[sIdx];
      const sitemapXml = await fetchGzip(sitemapUrl);
      if (!sitemapXml) {
        progress.last_sitemap_index = sIdx + 1;
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        continue;
      }

      const sitemapObj = await parseStringPromise(sitemapXml);
      const poemUrls = sitemapObj.urlset.url
        .map(u => u.loc[0])
        .filter(url => url.includes('/poem/') || url.includes('/poetry/'));

      for (let uIdx = progress.last_url_index; uIdx < poemUrls.length; uIdx++) {
        const url = poemUrls[uIdx];
        
        // Rapid Exist Check
        const urlParts = url.split('/');
        const poemFromUrl = urlParts[urlParts.length - 1]; // Approximate slug
        // Note: Real slugify is more accurate, but this avoids network if common match

        const result = await scrapePoem(url);
        
        if (result.status === 'blocked') {
          console.error(`[FATAL] Blocked by AllPoetry at Sitemap ${sIdx}, URL ${uIdx}.`);
          progress.last_run = new Date().toISOString();
          fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
          process.exit(1); // Exit with error for GH Action restart
        }

        if (result.status === 'success') {
          progress.total_scraped++;
          console.log(`[Saved] (${progress.total_scraped}) ${url}`);
        } else {
          // console.log(`[Skip] ${url}: ${result.error}`);
        }

        progress.last_url_index = uIdx + 1;
        // Periodic save every 25 poems
        if (progress.total_scraped % 25 === 0) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

        const delay = BATCH_WAIT_MIN + Math.random() * (BATCH_WAIT_MAX - BATCH_WAIT_MIN);
        await sleep(delay);
      }

      progress.last_sitemap_index = sIdx + 1;
      progress.last_url_index = 0;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    }

    // FINISHED ALL SITEMAPS
    progress.finished = true;
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    console.log(`[Task] ALL POEMS SCRAPED FOREVER!`);
  } catch (e) {
    console.error(`[Fatal] ${e.message}`);
    process.exit(1);
  }
}

main();
