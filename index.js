import { chromium } from 'playwright';
import { parse } from 'csv-parse/sync';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

// ── config ────────────────────────────────────────────────
const CSV_FILE = './songs.csv';
const AUTH_DIR = './auth';
const AUTH_FILE = path.join(AUTH_DIR, 'session.json');
const PLAYLIST_NAME = 'My Spotify Import';   // ← change to your playlist name
const DELAY_MS = 3000;                  // delay between songs
const LOGIN_MODE = process.argv.includes('--login');
// ─────────────────────────────────────────────────────────

async function loadSongs() {
    const raw = readFileSync(CSV_FILE, 'utf-8');
    const records = parse(raw, { columns: true, skip_empty_lines: true });
    return records.map(r => ({
        song: (r.Song || r.song || '').trim(),
        artist: (r.Artist || r.artist || '').trim(),
    })).filter(r => r.song && r.artist);
}

async function loginAndSave(browser) {
    console.log('\n🔐  Opening browser — please log into YouTube Music, then press ENTER here.\n');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('https://music.youtube.com');
    // Wait for user to manually log in
    await new Promise(r => process.stdin.once('data', r));
    if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR);
    await ctx.storageState({ path: AUTH_FILE });
    console.log('✅  Session saved to', AUTH_FILE);
    await ctx.close();
}

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function addSong(page, song, artist) {
    const query = `${song} ${artist} official audio`;
    console.log(`\n🔍  Searching: "${query}"`);

    try {
        // Navigate to search
        await page.goto(
            `https://music.youtube.com/search?q=${encodeURIComponent(query)}`,
            { waitUntil: 'domcontentloaded', timeout: 15000 }
        );
        await delay(2000);

        // Click first song result (shelf item)
        const firstResult = page.locator('ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer').first();
        if (!(await firstResult.isVisible({ timeout: 5000 }))) {
            console.log(`  ⚠️  No results found — skipping`);
            return false;
        }

        // Hover to reveal 3-dot menu
        await firstResult.hover();
        const menuBtn = firstResult.locator('button[aria-label="Action menu"]').first();
        await menuBtn.click({ timeout: 5000 });
        await delay(800);

        // Click "Save to playlist"
        const saveOption = page.locator('yt-formatted-string', { hasText: /save to playlist/i }).first();
        await saveOption.click({ timeout: 5000 });
        await delay(800);

        // Pick the playlist by name
        const playlistOption = page.locator('ytmusic-playlist-add-to-option-renderer', {
            hasText: new RegExp(PLAYLIST_NAME, 'i')
        }).first();
        await playlistOption.click({ timeout: 5000 });

        console.log(`  ✅  Added: ${song} — ${artist}`);
        return true;

    } catch (err) {
        console.log(`  ❌  Failed: ${song} — ${err.message.slice(0, 80)}`);
        // Close any stray menus
        await page.keyboard.press('Escape').catch(() => { });
        return false;
    }
}

async function main() {
    if (!existsSync(AUTH_FILE) && !LOGIN_MODE) {
        console.error('❌  No saved session found. Run: npm run login');
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: false });

    if (LOGIN_MODE) {
        await loginAndSave(browser);
        await browser.close();
        console.log('\n🎉  Done. Now run: npm start\n');
        return;
    }

    // Load session
    const ctx = await browser.newContext({ storageState: AUTH_FILE });
    const page = await ctx.newPage();

    const songs = await loadSongs();
    console.log(`\n📋  Loaded ${songs.length} songs from ${CSV_FILE}`);
    console.log(`🎵  Target playlist: "${PLAYLIST_NAME}"\n`);

    let added = 0, skipped = 0;

    for (const [i, { song, artist }] of songs.entries()) {
        console.log(`[${i + 1}/${songs.length}]`);
        const ok = await addSong(page, song, artist);
        ok ? added++ : skipped++;
        await delay(DELAY_MS);
    }

    console.log(`\n─────────────────────────────`);
    console.log(`✅  Added:   ${added}`);
    console.log(`⚠️   Skipped: ${skipped}`);
    console.log(`─────────────────────────────\n`);

    await ctx.close();
    await browser.close();
}

main().catch(console.error);