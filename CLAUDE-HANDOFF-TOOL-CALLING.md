# Max Guru — Tool Calling Handoff for Claude
**Date:** July 17, 2026  
**Context:** Bring Claude up to speed on the provider lookup feature we built today and the remaining issue.

---

## What We Built Today

### Architecture
- **Frontend:** `thei-max-guru.netlify.app` — React/JSX/Babel HTML with ~280KB embedded system prompt
- **Backend:** Railway (Node.js/Express) — `https://max-guru-production.up.railway.app`
- **Repo:** `https://github.com/igor-thei/max-guru-backend`

### New endpoints (already deployed + working)
```
GET  /drug-search?name=metformin   → Sunfire drug catalog search
POST /provider-lookup              → FHIR-based provider network lookup (FL Blue, Cigna, HealthSun, Devoted)
```

### What's in services/claude.js
Two new tools added to the TOOLS array:
1. **`lookup_provider_network`** — NPI Registry + FHIR carrier APIs (FL Blue, Cigna, HealthSun, Devoted)
2. **`search_drug`** — Sunfire drug search

### What's in server.js (pass-through handler)
The `/chat` endpoint, when given a `system` prompt (pass-through mode), now:
1. Passes `tools: TOOLS` to Anthropic
2. Has an agentic loop for `stop_reason === "tool_use"` API calls
3. Has reactive detection for `<tool_call>` text-narrated calls

---

## The Problem

### What's happening
When an agent asks Max "What plans is Dr. Tharkur in?":
1. ✅ Max tries to call the `lookup_provider_network` tool
2. ✅ The tool call fires (we can see it in the UI)
3. ❌ The tool RESULT is never given back to Claude
4. ❌ Max shows the raw tool call code in the UI instead of a clean answer

### Why
Claude is **narrating** tool calls in her TEXT response (writing `<tool_call>{"name": "lookup_provider_network", ...}</tool_call>` as plain text) rather than using Anthropic's proper `tool_use` API mechanism (which would give `stop_reason: "tool_use"` with a `tool_use` content block).

**Root cause:** The Max frontend sends a `system` prompt (~280KB). In our server.js pass-through handler, we DO pass `tools: TOOLS` to Anthropic. But Claude in this context is narrating tool calls as text instead of triggering the proper API tool_use flow. This means `stop_reason === "end_turn"` (not `"tool_use"`), so the agentic loop doesn't execute the tool.

We added reactive detection (in the latest commit) to catch `<tool_call>` tags in text and execute them — but we haven't confirmed this is working yet.

### The NPI issue (also fixed, verify it's deployed)
The NPI Registry search was also failing because the code was passing `first_name=` (empty string) which breaks the search. Fix: only include `first_name` param if non-empty.

---

## Current Code State

### services/claude.js — processTool for lookup_provider_network
```javascript
if (toolName === 'lookup_provider_network') {
  // 1. Parse doctorName into first/last
  // 2. Call NPI Registry: https://npiregistry.cms.hhs.gov/api/
  // 3. For each NPI found, query FHIR carriers (FL Blue, Cigna, HealthSun, Devoted)
  // 4. Return formatted string of plan affiliations
}
```

### server.js — reactive tool detection (latest commit b6a50c7)
After the API loop, if `stop_reason === "end_turn"` but the text contains `<tool_call>` tags:
1. Parse tool name + args from the tag
2. Call `processTool()` directly
3. Add result to messages
4. Make one final Anthropic call for the clean answer

---

## What Claude Needs to Fix

### Option A (preferred) — Force proper API tool calling
Figure out why Claude is narrating instead of using the API tool_use mechanism. This might be because:
- The 280KB system prompt is overriding Claude's tendency to use tools
- The system prompt has rules that say "I don't have provider data" (Rule 4) that need to be overridden
- A different approach to tool injection is needed

**Suggestion:** Add a `tool_choice: {"type": "auto"}` or even `tool_choice: {"type": "tool", "name": "lookup_provider_network"}` to force tool use when the question is about provider networks.

### Option B (fallback) — Make the reactive detection robust
If Option A is complex, make the reactive `<tool_call>` parsing more robust:
- Handle JSON in code blocks (```json ... ```) not just `<tool_call>` tags
- Handle "parameters" vs "arguments" vs "input" field names
- Make sure the result gets cleanly formatted back to the user

### Option C — Pre-intercept at the route level
Before sending to Anthropic, check if the question is about a doctor. If so, run the lookup FIRST, inject the results into the system prompt for that call, and let Claude answer with the data already present. No tool calling needed.

---

## Testing
```bash
# Test NPI search directly
curl "https://npiregistry.cms.hhs.gov/api/?version=2.1&last_name=Tharkur&state=FL&enumeration_type=NPI-1&limit=5"
# Returns: JEREMY THARKUR NPI 1306409339 ✅

# Test FHIR for that NPI
curl "https://apigw.bcbsfl.com/interop/interop-developer-portal/emr/api/v1/fhir/PractitionerRole?practitioner.identifier=1306409339" -H "Accept: application/fhir+json"
# Returns network affiliations ✅

# Test backend health
curl https://max-guru-production.up.railway.app/health
# Returns: {"ok":true} ✅
```

---

## Files to Read
- `server.js` — pass-through handler with tool support
- `services/claude.js` — TOOLS array + processTool function
- `routes/providerLookup.js` — FHIR lookup route (also works standalone)
- `routes/drugLookup.js` — Sunfire drug search route

---

## Quick Summary for Claude
Max can look up provider networks but the tool calling mechanism isn't completing the loop. Tools fire but results don't get back to Claude for a final answer. The NPI + FHIR APIs work perfectly when called directly. Need to either fix the API tool_use flow or make the reactive text-based fallback robust enough to complete the loop.
