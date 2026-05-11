// Handle API calls from content script to avoid CORS

const FREE_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "arcee-ai/trinity-large-thinking:free",
  "poolside/laguna-m.1:free"
];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "ASK_AI") {
    handleAIRequest(request.question, request.choices)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleAIRequest(question, choices) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    return { error: "No API key set. Right-click extension > Options to add your OpenRouter key." };
  }

  const choiceList = choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const prompt = `You are answering a multiple choice question. Pick the single best answer.

Question: ${question}

Choices:
${choiceList}

Reply with ONLY the number of the correct answer (e.g. "1" or "2"). Nothing else.`;

  // Try each free model until one works
  for (const model of FREE_MODELS) {
    const result = await tryModel(apiKey, model, prompt, choices.length);
    if (result.success) {
      console.log(`[EPZ-BG] Got answer from ${model}`);
      return { answerIndex: result.answerIndex };
    }
    if (result.fatal) {
      return { error: result.error };
    }
    // Rate limited or unavailable — try next model
    console.log(`[EPZ-BG] ${model} failed (${result.error}), trying next...`);
  }

  return { error: "All models rate-limited. Wait a minute and try again." };
}

async function tryModel(apiKey, model, prompt, numChoices) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (res.status === 429 || res.status === 503) {
      return { success: false, error: `${res.status} rate limited` };
    }

    if (res.status === 404) {
      return { success: false, error: `${res.status} model not found` };
    }

    if (res.status === 401 || res.status === 403) {
      return { success: false, fatal: true, error: "Invalid API key" };
    }

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `${res.status}: ${text.substring(0, 200)}` };
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return { success: false, error: "Empty response" };

    const match = reply.match(/(\d+)/);
    if (!match) return { success: false, error: `Unparseable: ${reply}` };

    const answerIndex = parseInt(match[1], 10) - 1;
    if (answerIndex < 0 || answerIndex >= numChoices) {
      return { success: false, error: `Index ${answerIndex + 1} out of range` };
    }

    return { success: true, answerIndex };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
