/**
 * adMeta — Cloud Function สำหรับแก้ปัญหา "การ์ดพรีวิว Facebook/LINE ไม่ขึ้นรูปสินค้า"
 * ------------------------------------------------------------------------------
 * ปัญหา: เว็บ CHIRASIN MARKET เป็น Single Page App (SPA) — ข้อมูลประกาศถูกดึงมาแสดง
 * ด้วย JavaScript หลังโหลดหน้าเสร็จ แต่ Facebook / LINE / Twitter crawler จะ "ไม่รัน
 * JavaScript เลย" มันอ่านแค่ HTML ดิบตอนโหลดครั้งแรกเท่านั้น จึงเห็นแค่รูป/ชื่อเว็บ
 * แบบเดียวกันหมดทุกลิงก์ ไม่ใช่รูปของประกาศนั้นๆ
 *
 * วิธีแก้: ทำ "Dynamic Rendering" — เมื่อมี request เข้ามาที่ /ad/:id
 *   - ถ้าเป็น bot (Facebook/LINE/Twitter/Googlebot ฯลฯ) → ส่ง HTML เปล่าๆ ที่มี
 *     <meta> ครบถ้วนของประกาศนั้นกลับไปเลย (ไม่ต้องรอ JS)
 *   - ถ้าเป็นผู้ใช้จริง (เปิดด้วยเบราว์เซอร์ปกติ) → เด้ง (redirect) ไปหน้าเว็บจริง
 *     ที่ /?view=ID ให้ SPA โหลดทำงานตามปกติ
 *
 * วิธี deploy (สรุปสั้นๆ อยู่ด้านล่างไฟล์นี้ และในคำตอบของ Claude)
 */

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// รายชื่อ user-agent ของ crawler/bot ที่เราต้องการเสิร์ฟ meta tag ให้แบบ static
// (ไม่ต้องรอ JavaScript รัน) — ครอบคลุม Facebook, LINE, Twitter/X, Google, และแอปแชทอื่นๆ
// ที่นิยมดึงพรีวิวลิงก์ในไทย
const BOT_UA_REGEX = /facebookexternalhit|Facebot|LinkedInBot|Twitterbot|Slackbot|TelegramBot|Discordbot|WhatsApp|Line\/|Googlebot|bingbot|Applebot/i;

const SITE_URL = 'https://chirasin-market.web.app';
const DEFAULT_IMAGE = SITE_URL + '/cover.jpg';

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ต้องเหมือนกับ sanitizeDocId() ฝั่ง client เป๊ะๆ (แทน / และ \ ด้วย _)
function sanitizeDocId(key) {
    return String(key).replace(/[\\/]/g, '_');
}

// 🖼️ หารูปแรกของประกาศที่ "ใช้ได้จริง" สำหรับ Facebook/LINE (ต้องเป็น URL http(s)://
// เท่านั้น — ห้ามเป็น data:... (base64) เพราะ crawler พวกนี้ดึงรูปจาก URL ไม่ได้
// รองรับทั้งกรณี images เป็น array ของ object {src, caption} และกรณีเป็น array ของ string ตรงๆ
function pickAdImage(ad) {
    var list = ad && ad.images;
    if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var src = (item && typeof item === 'object') ? item.src : item;
            if (typeof src === 'string' && /^https?:\/\//i.test(src)) {
                return src;
            }
        }
    }
    return DEFAULT_IMAGE;
}

exports.adMeta = onRequest({ region: 'asia-southeast1', cors: true }, async (req, res) => {
    try {
        // path ที่ hosting rewrite ส่งมาจะเป็นรูปแบบ /ad/<id>
        var parts = req.path.split('/').filter(Boolean); // ['ad', '<id>']
        var id = decodeURIComponent(parts[1] || '');

        var ua = req.get('User-Agent') || '';
        var isBot = BOT_UA_REGEX.test(ua);

        if (!id) {
            res.redirect(302, SITE_URL + '/');
            return;
        }

        var viewUrl = SITE_URL + '/?view=' + encodeURIComponent(id);

        // 👤 ผู้ใช้จริง เปิดผ่านเบราว์เซอร์ปกติ → เด้งไปหน้าเว็บจริงทันที ให้ SPA ทำงานตามปกติ
        if (!isBot) {
            res.redirect(302, viewUrl);
            return;
        }

        // 🤖 เป็น bot → ไปดึงข้อมูลประกาศจาก Firestore แล้วสร้าง HTML meta tag ให้ตรงกับประกาศนี้
        var docId = sanitizeDocId(id);
        var snap = await db.collection('kv').doc(docId).get();

        if (!snap.exists) {
            // ไม่พบประกาศ (อาจถูกลบ/ปิดไปแล้ว) → เสิร์ฟ meta ของหน้าแรกแทน กัน error เปล่าๆ
            res.redirect(302, SITE_URL + '/');
            return;
        }

        var ad;
        try {
            ad = JSON.parse(snap.data().value);
        } catch (e) {
            res.redirect(302, SITE_URL + '/');
            return;
        }

        var adPageUrl = SITE_URL + '/ad/' + encodeURIComponent(id);

        var title = escapeHtml(ad.title + (ad.price ? ' ฿' + ad.price : '') + ' | CHIRASIN MARKET');
        var desc = escapeHtml((ad.desc || ad.title || '').slice(0, 150));
        var image = escapeHtml(pickAdImage(ad));
        // 🔗 og:url / canonical ต้องชี้กลับมาที่ URL นี้เอง (/ad/ID) ไม่ใช่ /?view=ID เพราะ
        // Facebook จะตามลิงก์ใน og:url ไปเช็คซ้ำอีกรอบเสมอ ถ้าชี้ไปหน้า SPA (?view=)
        // ซึ่งไม่มี bot cloaking ช่วย จะได้ meta ของหน้าแรกกลับมาแทน (ผิดคน)
        var url = escapeHtml(adPageUrl);

        var html = '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">' +
            '<title>' + title + '</title>' +
            '<meta name="description" content="' + desc + '">' +
            '<link rel="canonical" href="' + url + '">' +
            '<meta property="og:type" content="product">' +
            '<meta property="og:url" content="' + url + '">' +
            '<meta property="og:title" content="' + title + '">' +
            '<meta property="og:description" content="' + desc + '">' +
            '<meta property="og:image" content="' + image + '">' +
            '<meta property="og:site_name" content="CHIRASIN MARKET">' +
            '<meta property="og:locale" content="th_TH">' +
            '<meta name="twitter:card" content="summary_large_image">' +
            '<meta name="twitter:title" content="' + title + '">' +
            '<meta name="twitter:description" content="' + desc + '">' +
            '<meta name="twitter:image" content="' + image + '">' +
            '</head><body>' +
            '<p>' + title + '</p><p><a href="' + url + '">' + url + '</a></p>' +
            '</body></html>';

        res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
        res.status(200).send(html);
    } catch (err) {
        console.error('adMeta error:', err);
        res.redirect(302, SITE_URL + '/');
    }
});

/**
 * saveJirasinAbout — บันทึกข้อความ "คำอธิบาย" ของเว็บ jirasin-video แบบปลอดภัย
 * ------------------------------------------------------------------------------
 * เดิมหน้าเว็บเช็ครหัสผ่านและเขียน Firestore ตรงๆ จากเบราว์เซอร์ (client-side) ทำให้
 * รหัสผ่านฝังอยู่ในซอร์สโค้ดหน้าเว็บ ใครกด "View Source" ก็เห็นได้ทันที — ไม่ปลอดภัยจริง
 *
 * ฟังก์ชันนี้ย้ายการเช็ครหัสผ่าน + การเขียนข้อมูลมาทำที่นี่แทน (ฝั่งเซิร์ฟเวอร์)
 * รหัสผ่านตัวจริงอยู่ในไฟล์นี้เท่านั้น ไม่เคยถูกส่งไปให้เบราว์เซอร์เห็นเลย
 *
 * ⚠️ ควรย้ายรหัสผ่านไปเก็บใน Firebase Secret Manager แทนการ hardcode ไว้ตรงนี้
 * ในระยะยาว (ดูคำแนะนำเพิ่มเติมท้ายไฟล์นี้) แต่วิธีนี้ปลอดภัยกว่าเดิมมากแล้ว
 */
const JIRASIN_ABOUT_PASSWORD = 'chirasin2026';
const JIRASIN_ABOUT_DOC_ID = 'jirasin-video-about'; // ตรงกับ firebase.firestore().doc("kv/jirasin-video-about") ฝั่ง client เป๊ะๆ

exports.saveJirasinAbout = onRequest({ region: 'asia-southeast1', cors: true }, async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'ใช้ได้เฉพาะ POST เท่านั้น' });
        return;
    }
    try {
        var body = req.body || {};
        var password = body.password;
        var text = (body.text || '').toString().trim();

        if (password !== JIRASIN_ABOUT_PASSWORD) {
            res.status(401).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
            return;
        }
        if (!text) {
            res.status(400).json({ ok: false, error: 'กรุณากรอกข้อความ' });
            return;
        }

        await db.collection('kv').doc(JIRASIN_ABOUT_DOC_ID).set({
            key: 'kv/jirasin-video-about',
            value: text,
            updatedAt: Date.now()
        });

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('saveJirasinAbout error:', err);
        res.status(500).json({ ok: false, error: 'บันทึกไม่สำเร็จ กรุณาลองใหม่' });
    }
});
