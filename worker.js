/**
 * OutreachGPT API — Cloudflare Worker
 * Proxies OpenAI calls, handles rate limiting, validates beta access codes.
 *
 * Environment variables (set via wrangler secret):
 *   OPENAI_API_KEY  — Your OpenAI API key
 *   BETA_CODES      — Comma-separated beta access codes
 *
 * KV Namespace:
 *   RATE_LIMITS     — Tracks daily usage per access code
 */

// ─── Config ─────────────────────────────────────────────────────────

const DAILY_LIMIT = 20; // emails per day per user
const CORS_ORIGIN = '*'; // Restrict to extension ID in production

// ─── Prompt Engine ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a cold email expert writing on behalf of the SENDER to the PROSPECT.

RULES:
1. The email pitches the SENDER's service to the PROSPECT, connecting it to their specific business.
2. Opening line references a SPECIFIC detail from the prospect's website. Not a compliment. Not "I noticed".
3. Body: 60-100 words MAX. 2-3 short paragraphs. No paragraph longer than 2 sentences.
4. End with a low-commitment question: "Worth a conversation?" / "Make sense to chat?" / "Curious?"
5. Sign off with ONLY the sender's first name on its own line. NEVER the prospect's name or company.
6. No exclamation marks. No "excited", "thrilled", "love", "amazing", "impressed", "incredible".
7. Do NOT start the email body with "I". Start with the prospect's name, then a comma.

BANNED PHRASES (never use any):
"I hope this email finds you well", "I came across", "I noticed", "Noticing", "reaching out because", "just wanted to", "touch base", "synergy", "leverage", "game-changer", "game changer", "take your X to the next level", "in today's competitive landscape", "in today's", "it's clear that", "no small feat", "I'd love to", "Are you open to", "I believe", "our solution", "unlock", "drive results", "boost your", "streamline", "vying for attention", "carving out", "resonate with", "What sets you apart"

OUTPUT FORMAT (you MUST follow this exactly):
SUBJECT: [3-7 words, lowercase feel, related to the pitch]
---
[prospect name],

[email body]

[sender first name]`;

const TYPE_PROMPTS = {
  intro: 'Write a first-touch cold email. The prospect has never heard of the sender. Pitch the sender\'s service as relevant to the prospect\'s specific business. The opening line must reference a specific detail from their website — not a generic observation.',
  followup: 'Write a follow-up to a cold email sent 4 days ago that got no reply. Do NOT repeat the original pitch or guilt them. Share ONE new angle or specific idea. Under 50 words. Casual.',
};

const TONE_PROMPTS = {
  professional: 'Warm but businesslike. A peer emailing another peer.',
  casual: 'Friendly and short. Slack DM energy.',
};

const OPENERS = [
  'Reference a SPECIFIC product or feature from their website.',
  'Name their TARGET CUSTOMER and a problem they face.',
  'Reference their MARKET or location.',
  'Reference their website copy and pivot to the offer.',
  'Mention how they POSITION themselves.',
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

PROSPECT: ${prospectName || '(unknown)'}, ${prospectRole || ''} at ${pageContext.companyName || ''}

WEBSITE CONTEXT:
${context || 'Limited context available.'}

REQUIREMENTS:
- Pitch ${senderInfo.company}'s service to the prospect
- Reference a specific website detail
- Sign off as "${senderFirstName}" — never use prospect's name
- Stay under 100 words
- Format: SUBJECT: ... then --- then email body`;
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

// ─── Rate Limiting ──────────────────────────────────────────────────

async function checkRateLimit(env, code) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${code}:${today}`;
  const current = parseInt(await env.RATE_LIMITS.get(key) || '0');

  if (current >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  await env.RATE_LIMITS.put(key, String(current + 1), { expirationTtl: 86400 });
  return { allowed: true, remaining: DAILY_LIMIT - current - 1 };
}

// ─── Request Handler ────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': CORS_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === '/generate') {
      return handleGenerate(request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

async function handleGenerate(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  // Validate access code (beta)
  const betaCodes = (env.BETA_CODES || '').split(',').map(c => c.trim()).filter(Boolean);
  if (betaCodes.length > 0 && data.accessCode) {
    if (!betaCodes.includes(data.accessCode)) {
      return jsonResponse({ error: 'Invalid access code' }, 403);
    }

    // Rate limit
    const rateCheck = await checkRateLimit(env, data.accessCode);
    if (!rateCheck.allowed) {
      return jsonResponse({ error: `Daily limit reached (${DAILY_LIMIT}/day). Try again tomorrow.`, remaining: 0 }, 429);
    }
  }

  // Validate required fields
  if (!data.pageContext || !data.senderInfo?.name) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  // Build prompt and call OpenAI
  const userPrompt = buildPrompt(data);
  const senderFirstName = data.senderInfo.name?.split(' ')[0] || '';

  try {
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
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

    if (!aiResponse.ok) {
      const err = await aiResponse.json().catch(() => ({}));
      return jsonResponse({ error: err.error?.message || 'AI generation failed' }, 502);
    }

    const aiResult = await aiResponse.json();
    const raw = aiResult.choices[0].message.content.trim();
    const parsed = parseResponse(raw, senderFirstName, data.prospectName, data.pageContext?.companyName);

    return jsonResponse({
      success: true,
      subject: parsed.subject,
      body: parsed.body,
    });

  } catch (error) {
    return jsonResponse({ error: 'Generation failed. Try again.' }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': CORS_ORIGIN,
    },
  });
}
