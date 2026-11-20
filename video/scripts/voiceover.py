"""Generates the English voice-over (edge-tts) and word-level timings into public/vo/ and src/voiceover.json.
Run with the edge-tts virtualenv:  ~/G-WEB-500-COT-5-1-dashboard-9/video-tts-venv/bin/python scripts/voiceover.py
Only new or edited lines are regenerated."""
import asyncio, json, pathlib
import edge_tts

VOICE = "en-US-AvaNeural"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "vo"
LINES = [
    ("hook", "Support agents don't lack knowledge. They lack the right moment. The answer exists somewhere, in an article, in an old ticket, in a colleague's head. It just arrives ten minutes too late."),
    ("intro", "Meet Kairos. The support copilot for Jira Service Management and Confluence. It acts at the right moment, in your language, on any screen."),
    ("landing", "Start on the landing page. A live sundial whose shadow turns by itself, and that you can drag with a finger or a mouse. A complete day and night theme, real product shots, and a copilot you can try right away."),
    ("auth", "Sign up with a six-digit code sent by e-mail, or continue with Google or GitHub. Or open the instant demo, no password needed. Sessions rotate, accounts lock after repeated failures, and two-factor authentication works with any authenticator app, with single-use backup codes."),
    ("dashboard", "Your day at a glance. Open requests, first response time, SLA compliance, and a forecast of which tickets will breach before they actually do. Kairos spots an emerging incident the moment requests spike, and points at the suspect deployment."),
    ("tickets", "Requests live in one fast queue. Filter, sort, assign in bulk, export to CSV. Open one, and Kairos adds the context: tone and frustration, similar past cases, the best article, and who should take it."),
    ("copilot", "Then, the copilot. Ask a question in any language. It answers only with sentences that already exist in your articles and past resolutions, each one cited. A confidence ring shows how sure it is. And when it doesn't know, it says so, and hands over to a human. No paid language model. Nothing invented."),
    ("intelligence", "Behind it, forty-eight analyses, without any LLM. Documentation gaps, stale articles, duplicate clusters, workload fairness, backlog and capacity forecasts, customer segments, and churn risk."),
    ("search", "Search is a single box. Type, and tickets, customers, teammates, channels, messages and articles appear instantly. Even with typos, and partial words."),
    ("chat", "Your team gets its own space. Channels and direct messages, tickets linked by their key, and WhatsApp-style replies. Right-click on a computer, swipe on a phone. Share images and files, and every upload is checked for malware, scripts and macros before it is stored."),
    ("workspace", "Customers with their plan and history. Your team, with skills and languages. Automation rules that raise a priority, or escalate a customer who threatens to leave. Signed webhooks, protected against server-side request forgery, and scoped API keys for your integrations."),
    ("settings", "Add a profile photo, review your active sessions, and read a tamper-evident audit log. Personal data is masked before anything leaves your server."),
    ("languages", "Everything speaks French, English and Spanish, and switches instantly. Even the demo content follows your language."),
    ("responsive", "And it fits every screen. Phone, tablet, desktop. Install it as an app, with an offline fallback. Light, or dark. Your choice."),
    ("brain", "Under the hood, Kairos Brain. An open-source multilingual model that we host ourselves. It estimates resolution time and reopening risk, but only after it beats simple baselines, in nested cross-validation and a permutation test. A model that doesn't pass is simply not served."),
    ("stack", "A Fastify and PostgreSQL API, a React frontend, and a Forge app with a Rovo agent for Jira. Deployed on Vercel, Neon and Modal. A hundred and fifty-three automated tests. And no paid API, anywhere."),
    ("recap", "All of it, in one product. Installable as an app. In three languages. Light or dark. On any screen, even offline. With two-factor security, team chat and safe uploads, signed webhooks and API keys, and a Rovo agent with MCP tools."),
    ("outro", "Kairos. The right answer, at the right moment."),
]


async def one(key, text):
    com = edge_tts.Communicate(text, VOICE, rate="+0%", boundary="WordBoundary")
    words, audio = [], bytearray()
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
        elif chunk["type"] == "WordBoundary":
            start = chunk["offset"] / 1e7
            words.append({"text": chunk["text"], "start": round(start, 3), "end": round(start + chunk["duration"] / 1e7, 3)})
    (OUT / f"{key}.mp3").write_bytes(audio)
    return {"key": key, "text": text, "words": words}


async def with_retry(key, text):
    for attempt in range(8):
        try:
            return await asyncio.wait_for(one(key, text), timeout=60)
        except Exception as exc:
            print(f"{key}: attempt {attempt + 1} failed ({type(exc).__name__})", flush=True)
            await asyncio.sleep(4 * (attempt + 1))
    raise RuntimeError(f"voice-over failed for {key}")


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    js = ROOT / "src" / "voiceover.json"
    cached = {d["key"]: d for d in json.loads(js.read_text())} if js.exists() else {}
    data = []
    for k, t in LINES:
        hit = cached.get(k)
        data.append(hit if hit and hit["text"] == t and (OUT / f"{k}.mp3").exists() else await with_retry(k, t))
        print("ok", k, flush=True)
    js.write_text(json.dumps(data, ensure_ascii=False, indent=1))


asyncio.run(main())
