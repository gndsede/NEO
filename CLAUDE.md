# NEO Soluções Civis — instruções do projeto

Monorepo: `backend/` (Node/Prisma), `frontend/` (TanStack Start + Tailwind v4 + shadcn,
submódulo git), `app-catraca/` (Expo/React Native).

Ambiente: Windows. Python é invocado por `py` (não `python`/`python3`).

---

# Diretriz de design — anti-AI-slop (vale para TODA a interface)

Aplica-se à landing page, ao sistema interno (`frontend/`), ao super-admin e ao
app da catraca. Não é guia de landing page: é o padrão visual do produto.

## Regra central

Nenhum elemento existe para "preencher", "dar cara de design" ou ocupar espaço.
Todo elemento precisa organizar informação, estabelecer hierarquia, comunicar
significado, orientar leitura, demonstrar algo ou reforçar a identidade.

Antes de adicionar qualquer componente:
**"Se eu remover isso, alguma informação, hierarquia, significado ou experiência
relevante é perdida?"** Se não, o elemento não deveria existir.

## Proibições

1. **Sem traço decorativo em eyebrow.** Nada de `<span class="h-px w-8 …" />` antes
   de label/eyebrow/título. O eyebrow se sustenta por tipografia, peso, tamanho,
   cor, espaçamento e contraste com o título.
2. **Sem pseudo-quote.** Barra vertical, aspas gigantes, fundo contrastante ou
   tipografia de citação só quando o texto *é* citação, depoimento ou fala
   atribuída. Parágrafo comum não vira blockquote porque a seção parecia vazia.
3. **Numeração só quando informa.** `01 02 03` é permitido em etapa sequencial,
   ordem cronológica, ranking ou prioridade. Se trocar `03` por `07` não muda
   nada, o número é enfeite — remova. Número não substitui ícone.
4. **Sem faixa de métricas superficial.** Nenhuma seção de 3–4 números criada por
   hábito de template. Dado só aparece se ajudar a decidir — e incorporado à
   narrativa (dentro do case, da metodologia, do perfil), não isolado numa faixa.
5. **Número sem fonte não entra.** Percentual, volume, SLA e contagem só na
   interface se vierem da API, de um relatório ou de um dado verificável do
   cliente. Nada de valor ilustrativo em produção.
6. **Se uma faixa de métricas se justificar, trate-a como experiência:** contagem
   ao entrar na viewport, stagger discreto, movimento elegante e rápido —
   sempre sob `prefers-reduced-motion`.
7. **Design não é acúmulo.** Antes de adicionar linha, badge, pill, ícone,
   círculo, seta ou ornamento, resolva espaço, grid, alinhamento, contraste,
   escala, ritmo, hierarquia e respiro. Título + texto + imagem já pode bastar.
8. **Não repita a mesma estrutura em todas as seções** (eyebrow + título +
   parágrafo + 3 cards). Varie o ritmo conforme o conteúdo.
9. **Nada sem semântica:** ícone que não representa, gráfico sem dados, selo sem
   certificado, estrela sem avaliação, percentual inventado.
10. **Evite a estética "template premium genérico":** cantos exagerados, sombras
    por todos os lados, gradientes gratuitos, glassmorphism, glow, bento grid
    decorativo, ícones dentro de círculos.
11. **Cada componente precisa ganhar o direito de existir.** Não traz informação,
    direção, prova ou vazão? Corte.

## Convenções já fixadas no código

- Raio de card: `studio-card` (0.75rem). Não usar `rounded-3xl` em cards.
- Sem `studio-glass` em página (blur só em overlay de modal, onde tem função).
- Sem `box-shadow` de glow em botão/card.
- Motion via `Reveal` (`data-reveal`), desligado por `prefers-reduced-motion`.
- Eyebrow: `PageHeader` do `page-shell.tsx`, só tipografia.

## Checklist antes de entregar UI

Traço decorativo? Quote falso? Número em série sem valor? Número sem fonte?
Elemento sem função? Seções com a mesma estrutura? Excesso de cards?
Dá para cortar 20% sem prejuízo? Então corte.
