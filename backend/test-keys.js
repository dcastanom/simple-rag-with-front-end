require('dotenv').config();

console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.slice(0, 8) + '...' : 'MISSING');
console.log('GROQ_API_KEY:  ', process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.slice(0, 8) + '...' : 'MISSING');

// Test Gemini embedding
async function testGemini() {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: 'test' }] } }),
    }
  );
  const data = await res.json();
  if (res.ok) console.log('Gemini embedding: OK (dimensions:', data.embedding.values.length, ')');
  else console.log('Gemini embedding: FAILED -', data.error?.message);
}

// Test Groq generation
async function testGroq() {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Say "works" in one word.' }],
    }),
  });
  const data = await res.json();
  if (res.ok) console.log('Groq generation: OK -', data.choices[0].message.content);
  else console.log('Groq generation: FAILED -', data.error?.message);
}

testGemini().then(testGroq);
