const fs = require('fs');
const path = require('path');

const METADATA_FILE = path.join(__dirname, '../automation/all-poems-metadata.json');
const CONTENT_DIR = path.join(__dirname, '../allpoetry');

function slugify(text) {
  return text.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-');
}

async function backfill() {
  if (!fs.existsSync(METADATA_FILE)) {
    console.error("Metadata file not found!");
    return;
  }

  console.log("🚀 Starting metadata backfill...");
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE));
  let updatedCount = 0;

  for (let i = 0; i < metadata.length; i++) {
    const item = metadata[i];
    const writerSlug = item.writerSlug || slugify(item.writer);
    const poemSlug = item.slug;
    
    const filePath = path.join(CONTENT_DIR, writerSlug, `${poemSlug}.md`);
    
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      
      if (fmMatch) {
         const poemBody = fmMatch[2].trim();
         const snippet = poemBody.slice(0, 200).replace(/\n/g, ' ') + (poemBody.length > 200 ? '...' : '');
         
         if (item.content !== snippet) {
            metadata[i].content = snippet;
            metadata[i].writerSlug = writerSlug; // Ensure writerSlug is there too
            updatedCount++;
         }
      }
    }

    if (i % 500 === 0) console.log(`Processed ${i}/${metadata.length}...`);
  }

  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  console.log(`✅ Backfill complete! Updated ${updatedCount} items.`);
}

backfill();
