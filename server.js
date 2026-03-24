/**
 * OutreachGPT API — Express Server
 * Proxies OpenAI calls, handles rate limiting, validates beta access codes.
 * Designed for deployment on Coolify via GitHub.
 *
 * Environment variables:
 *   OPENAI_API_KEY  — Your OpenAI API key
 *   BETA_CODES      — Comma-separated beta access codes (optional)
 *   PORT            — Server port (default: 3000)
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  // Chrome extension origin (set EXTENSION_ID env var after loading extension)
  process.env.EXTENSION_ID ? `chrome-extension://${process.env.EXTENSION_ID}` : null,
  // Local development
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (server-to-server, curl, health checks)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // In beta, also allow chrome-extension:// origins generically
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    callback(new Error('CORS: origin not allowed'));
  },
}));
app.use(express.json());

// ─── In-Memory Rate Limiting ────────────────────────────────────────

const DAILY_LIMIT = 20;
const rateLimits = new Map(); // code:date -> count

function cleanOldEntries() {
  const today = new Date().toISOString().split('T')[0];
  for (const [key] of rateLimits) {
    if (!key.endsWith(today)) rateLimits.delete(key);
  }
}

// Clean stale entries every hour
setInterval(cleanOldEntries, 3600000);

function checkRateLimit(code) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${code}:${today}`;
  const current = rateLimits.get(key) || 0;

  if (current >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  rateLimits.set(key, current + 1);
  return { allowed: true, remaining: DAILY_LIMIT - current - 1 };
}

// ─── Prompt Engine ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You write cold emails on behalf of the SENDER to the PROSPECT. Your emails are short, direct, and impossible to mistake for AI.

STRUCTURE (mandatory):
- Line 1: Prospect's first name + comma (or "Hi," if no name given)
- Paragraph 1 (1-2 sentences): Name ONE specific thing from their website — a product name, a price, a claim, a feature, a stat. Not a vague category. Then connect it to the sender's service.
- Paragraph 2 (1-2 sentences): State exactly what the sender does and why the prospect should care. Be concrete. "We do X which means Y for you" not "we help businesses with Z".
- Last line: A short question. "Worth a chat?" / "Make sense to connect?" / "Curious?"
- Sign off: sender's first name on its own line. Nothing else. No "Best,". No "Regards,".

HARD RULES:
- MAXIMUM 80 words in the body. Count them. If over 80, cut.
- Do NOT start any sentence with "I". Rewrite to avoid it.
- Do NOT compliment them. No "impressive", "great", "amazing", "incredible", "love what you do", "powerful".
- Do NOT use filler. Every sentence must contain either a specific fact or a concrete offer.
- Do NOT say "businesses like yours" or "companies like [name]". Say "you" or "your [specific thing]".
- Do NOT use "strategy", "solution", "leverage", "unlock", "streamline", "optimize", "boost", "empower", "mission", "journey".
- Do NOT say "the right audience", "connect with", "reach more", "grow your" — these are empty phrases.
- Do NOT invent statistics, percentages, or client results unless they appear in the sender's offer description.
- Do NOT fabricate the prospect's name. If no name is given, use "Hi,".
- The subject line must be lowercase-feeling, 3-6 words, and specific to the pitch.

BANNED PHRASES (instant fail if used):
"I hope this email finds you well", "I came across", "I noticed", "Noticing", "reaching out because", "just wanted to", "touch base", "synergy", "leverage", "game-changer", "take your X to the next level", "in today's", "it's clear that", "no small feat", "I'd love to", "Are you open to", "I believe", "our solution", "unlock", "drive results", "boost your", "streamline", "vying for attention", "carving out", "resonate with", "What sets you apart", "trusted", "impressive", "mission", "helping businesses", "tailored", "ensuring", "effectively", "can help you", "competitive landscape", "powerful"

OUTPUT FORMAT:
SUBJECT: [subject]
---
[email body]`;

const TYPE_PROMPTS = {
  intro: 'First cold email. Prospect has never heard of sender. Name a SPECIFIC fact from their website in sentence 1 — a product, a price, a stat, a claim. Then pitch the sender\'s service as the fix for a specific problem that fact implies.',
  followup: 'Brief follow-up to an ignored cold email from 4 days ago. Do NOT repeat the pitch. Share one new specific idea or angle. Max 40 words. Very casual.',
};

const TONE_PROMPTS = {
  professional: 'Peer-to-peer. No formality. No fluff. A founder emailing another founder.',
  casual: 'Short. Punchy. Feels like a Slack DM from someone you\'d want to grab coffee with.',
};

const OPENERS = [
  'Name a SPECIFIC product, price, or stat from their website. Not a category — an actual thing.',
  'Quote or paraphrase a SPECIFIC line of copy from their website.',
  'Name a SPECIFIC problem their customers have that relates to the sender\'s offer.',
  'Reference a SPECIFIC market, city, or niche they serve.',
  'Name something MISSING from their website that the sender could fix.',
];

function buildPrompt(data) {
  const { pageContext, senderInfo, prospectName, prospectRole, emailType, tone, customGoal } = data;
  const senderFirstName = senderInfo.name?.split(' ')[0] || '';

  let context = '';
  if (pageContext.companyName) context += `Company: ${pageContext.companyName}\n`;
  if (pageContext.description) context += `What they do: ${pageContext.description}\n`;
  if (pageContext.headings?.length) context += `Headings: ${pageContext.headings.slice(0, 4).join('; ')}\n`;
  if (pageContext.aboutText) context += `About: ${pageContext.aboutText.slice(0, 300)}\n`;
  if (pageContext.url) context += `URL: ${pageContext.url}\n`;

  let goalSection = '';
  if (customGoal) {
    goalSection = `\nUSER'S GOAL (HIGHEST PRIORITY): ${customGoal}\nWrite the email to achieve this goal. Connect it to the prospect's business.\n`;
  }

  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];

  return `${TYPE_PROMPTS[emailType] || TYPE_PROMPTS.intro}

TONE: ${TONE_PROMPTS[tone] || TONE_PROMPTS.professional}
OPENER: ${opener}
${goalSection}
SENDER: ${senderInfo.name}, ${senderInfo.role} at ${senderInfo.company}
Offer: ${senderInfo.offer}
Sign off as: ${senderFirstName}

PROSPECT: ${prospectName || '(no name — use "Hi," instead. NEVER make up a name.)'}
Role: ${prospectRole || '(unknown)'}
Company: ${pageContext.companyName || '(from website)'}

WEBSITE CONTEXT:
${context || 'Limited context available.'}

CRITICAL:
- Pitch ${senderInfo.company}'s service to the prospect
- Reference a SPECIFIC detail from THEIR website
- NEVER invent statistics or percentages you don't know
- NEVER fabricate the prospect's name
- Sign off as "${senderFirstName}" only
- MAX 80 words
- Format: SUBJECT: ... then --- then body`;
}

function parseResponse(raw, senderFirstName, prospectName, prospectCompany) {
  let subject = '';
  let body = '';

  const subjectMatch = raw.match(/^SUBJECT:\s*(.+)/im);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    const subjectEnd = raw.indexOf(subjectMatch[0]) + subjectMatch[0].length;
    const afterSubject = raw.substring(subjectEnd);
    const dashIdx = afterSubject.indexOf('---');
    body = dashIdx !== -1
      ? afterSubject.substring(dashIdx + 3).trim()
      : afterSubject.replace(/^\s*\n/, '').trim();
  } else {
    const nl = raw.indexOf('\n');
    if (nl !== -1) {
      subject = raw.substring(0, nl).replace(/^---\s*/, '').trim();
      body = raw.substring(nl + 1).replace(/^---\s*/, '').trim();
    } else {
      subject = 'quick question';
      body = raw;
    }
  }

  // Clean artifacts
  body = body.replace(/^(Best regards|Best|Warm regards|Cheers|Kind regards),?\s*$/gim, '').trim();

  // Fix sign-off
  const lines = body.split('\n');
  const lastLine = lines[lines.length - 1]?.trim();
  const prospectFirst = prospectName?.split(' ')[0] || '';

  if (lastLine && senderFirstName) {
    if ((prospectFirst && lastLine.toLowerCase() === prospectFirst.toLowerCase()) ||
        (prospectCompany && lastLine.toLowerCase() === prospectCompany.toLowerCase())) {
      lines[lines.length - 1] = senderFirstName;
    }
  }

  if (senderFirstName) {
    const lastNonEmpty = lines.filter(l => l.trim()).pop()?.trim() || '';
    if (lastNonEmpty !== senderFirstName) {
      lines.push('', senderFirstName);
    }
  }

  body = lines.join('\n').trim();
  return { subject, body };
}

// ─── Routes ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ name: 'OutreachGPT API', status: 'running', endpoints: ['POST /generate', 'GET /health'] });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/generate', async (req, res) => {
  const data = req.body;

  // Validate API key is configured
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Server not configured. Missing OPENAI_API_KEY.' });
  }

  // Validate access code (if beta codes are set)
  const betaCodes = (process.env.BETA_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
  if (betaCodes.length > 0) {
    if (!data.accessCode || !betaCodes.includes(data.accessCode)) {
      return res.status(403).json({ error: 'Invalid access code.' });
    }

    const rateCheck = checkRateLimit(data.accessCode);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: `Daily limit reached (${DAILY_LIMIT}/day). Try again tomorrow.`, remaining: 0 });
    }
  }

  // Validate required fields
  if (!data.pageContext || !data.senderInfo?.name) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Build prompt and call OpenAI
  const userPrompt = buildPrompt(data);
  const senderFirstName = data.senderInfo.name?.split(' ')[0] || '';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.85,
        max_tokens: 350,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('OpenAI error:', err);
      return res.status(502).json({ error: err.error?.message || 'AI generation failed.' });
    }

    const result = await response.json();
    const raw = result.choices[0].message.content.trim();
    const parsed = parseResponse(raw, senderFirstName, data.prospectName, data.pageContext?.companyName);

    console.log(`[${new Date().toISOString()}] Generated email for ${data.pageContext?.companyName || 'unknown'}`);

    return res.json({
      success: true,
      subject: parsed.subject,
      body: parsed.body,
    });

  } catch (error) {
    console.error('Generation error:', error.message);
    return res.status(500).json({ error: 'Generation failed. Try again.' });
  }
});

// ─── Start Server ───────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`OutreachGPT API running on port ${PORT}`);
  console.log(`Beta codes: ${process.env.BETA_CODES ? 'configured' : 'none (open access)'}`);
});
