# GitHub Repo Setup — Run after `gh auth login -h github.com`

## 1. Create the repo
```bash
cd /Users/flint/.openclaw/workspace/projects/lodestone
gh repo create greyrock-studios/lodestone --public --description "🔮 Turn any LLM into a self-improving agent. 39 tools, 290 tests, MIT licensed." --homepage "https://lodestone.greyrockstudios.com"
```

## 2. Push the code
```bash
git remote set-url origin https://github.com/greyrock-studios/lodestone.git
git push -u origin main
```

## 3. Add topics
```bash
gh api repos/greyrock-studios/lodestone/topics -X PUT -f names[]=ai -f names[]=agent -f names[]=llm -f names[]=typescript -f names[]=automation -f names[]=chatbot -f names[]=rag -f names[]=self-improving -f names[]=open-source -f names[]=framework
```

## 4. Create release
```bash
gh release create v0.1.0 --title "Lodestone v0.1.0 — Initial Release" --notes "39 built-in tools, 290 tests, 52K+ lines TypeScript. Memory, self-improvement, proactive scheduling, safety systems, multi-channel. MIT licensed."
```

## 5. npm publish (after `npm login`)
```bash
npm publish
```

## 6. Gumroad product creation (after Gumroad login)
Create product at gumroad.com/products/new:
- Name: Lodestone Pro — Self-Improving AI Agent Engine
- Price: $97 (early access)
- Description: See gumroad-listing.md
- Preview URL: https://lodestone.greyrockstudios.com