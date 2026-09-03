const axios = require('axios');

const VIDLINK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Referer': 'https://vidlink.pro/',
    'Origin': 'https://vidlink.pro'
};

function buildCaptions(captions) {
    if (!Array.isArray(captions)) return [];
    return captions
        .filter(cap => cap && cap.url)
        .map(cap => ({
            id: cap.id,
            url: cap.url,
            label: cap.language || cap.lanName || 'Unknown',
            lang: cap.language || cap.lan || 'en',
            format: (cap.type || (cap.url.includes('.vtt') ? 'vtt' : 'srt')).toLowerCase()
        }));
}

function buildStreamsFromQualities(qualities, captions) {
    const streams = [];
    if (!qualities || typeof qualities !== 'object') return streams;

    for (const [qualityKey, info] of Object.entries(qualities)) {
        if (!info || !info.url) continue;
        const resolution = /^\d{3,4}$/.test(qualityKey) ? `${qualityKey}p` : (info.resolution || qualityKey);
        const codec = info.codecName ? ` ${info.codecName.toUpperCase()}` : '';
        streams.push({
            name: `Vidlink - ${resolution}${codec}`,
            title: `Vidlink - ${resolution}${codec}`,
            url: info.url,
            quality: resolution,
            type: info.type || 'mp4',
            provider: 'Vidlink',
            codec: info.codecName || null,
            headers: { 'Referer': 'https://vidlink.pro/' },
            subtitles: captions
        });
    }

    // Highest quality first
    return streams.sort((a, b) => {
        const qa = parseInt(String(a.quality).replace(/\D/g, ''), 10) || 0;
        const qb = parseInt(String(b.quality).replace(/\D/g, ''), 10) || 0;
        return qb - qa;
    });
}

async function getVidlinkStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Vidlink] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    try {
        // Step 1: Encrypt the TMDB ID via enc-dec.app (mirrors working Python)
        const encRes = await axios.get(
            `https://enc-dec.app/api/enc-vidlink?text=${encodeURIComponent(String(tmdbId))}`,
            { timeout: 8000 }
        );
        const encodedTmdb = encRes.data && encRes.data.result;
        if (!encodedTmdb) {
            console.log('[Vidlink] Encryption step returned no result.');
            return [];
        }

        // Step 2: Fetch stream from Vidlink API (matches Python URL pattern, no multiLang param)
        const apiUrl = mediaType === 'tv'
            ? `https://vidlink.pro/api/b/tv/${encodedTmdb}/${seasonNum}/${episodeNum}`
            : `https://vidlink.pro/api/b/movie/${encodedTmdb}`;

        const apiRes = await axios.get(apiUrl, { headers: VIDLINK_HEADERS, timeout: 10000 });
        const data = apiRes.data;
        const stream = data && data.stream;
        if (!stream) {
            console.log('[Vidlink] No stream object in response.');
            return [];
        }

        const captions = buildCaptions(stream.captions || []);

        // New response shape: stream.qualities is an object keyed by quality (e.g. "360", "720", "1080")
        const qualities = stream.qualities;
        if (qualities && typeof qualities === 'object') {
            const built = buildStreamsFromQualities(qualities, captions);
            if (built.length > 0) {
                console.log(`[Vidlink] Got ${built.length} quality stream(s).`);
                return built;
            }
        }

        // Backwards-compat: older API returned stream.playlist (HLS m3u8 URL)
        const playlist = stream.playlist;
        if (playlist) {
            console.log(`[Vidlink] Got playlist stream.`);
            return [{
                name: 'Vidlink',
                title: 'Vidlink',
                url: playlist,
                quality: 'Auto',
                type: 'hls',
                provider: 'Vidlink',
                headers: { 'Referer': 'https://vidlink.pro/' },
                subtitles: captions
            }];
        }

        console.log('[Vidlink] No playlist or qualities in response.');
        return [];
    } catch (err) {
        console.error(`[Vidlink] Error: ${err.message}`);
        return [];
    }
}

module.exports = { getVidlinkStreams };
