require('dotenv').config();

async function listModels() {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models?key=${process.env.GEMINI_API_KEY}`
  );
  const data = await res.json();

  const embeddingModels = data.models?.filter(m =>
    m.supportedGenerationMethods?.includes('embedContent')
  );
  const chatModels = data.models?.filter(m =>
    m.supportedGenerationMethods?.includes('generateContent')
  );

  console.log('\nAvailable embedding models:');
  embeddingModels?.forEach(m => console.log(' -', m.name));

  console.log('\nAvailable generation models:');
  chatModels?.forEach(m => console.log(' -', m.name));
}

listModels();
