# Tarefas — wacrm

> Registro do que já foi feito e do que ainda falta. Atualizar a cada
> sessão de trabalho (mover item de "Pendentes" pra "Feitas" quando
> entregar, adicionar item novo quando surgir um pedido ou um gap).

## Pendentes

- [ ] **Sem sinal visual no inbox quando a IA para de responder uma
  conversa** (handoff ou limite de respostas atingido). Descoberto
  investigando o incidente de 10/08 na Churrascaria Concórdia: 84
  conversas ficaram sem IA e sem humano, sem nenhum badge/filtro
  avisando — só descobre entrando em cada uma. Vale um indicador na
  lista do inbox (algo tipo "IA pausada") e/ou um filtro pra achar
  essas conversas rápido.
- [ ] **`auto_reply_max_per_conversation` da Concórdia foi pra 15** (era
  3) como mitigação de emergência em 10/08 — revisar com o dono da
  conta se esse é o valor certo pro negócio, ou se deveria ser
  configurável por padrão pra conta nova ficar num valor mais
  realista desde o início (3 é baixo demais pra um pedido típico).
- [ ] **Conversa com contato que só manda "Presente Diário" (imagem +
  áudio automático, sem texto real)** nunca recebeu nenhuma resposta
  da IA apesar de várias mensagens — pode ser um contato que não é
  cliente de verdade (só usa o número pra reenviar devocional). Não
  mexido — baixo impacto, mas vale confirmar com o dono se é
  legítimo.
- [ ] **Confirmação de pagamento Pix feito "por fora"** — a IA não
  sabe lidar com um cliente que diz ter pago via Pix fora do fluxo
  automático (sem gateway pra confirmar). Discussão começou e foi
  interrompida antes de decidir o comportamento (avisar a equipe e
  aguardar? confiar na palavra do cliente e marcar como pago?
  pedir print do comprovante?) — revisitar quando o dono da conta
  trouxer o assunto de novo.
- [ ] **Log de diagnóstico temporário ainda ligado em produção** —
  `src/lib/delivery/fee-engine.ts`, no catch de `calculateDistance`,
  tem um `console.error` extra (`JSON.stringify({origin, destination,
  resolvedLabel, estimateKm})`) comentado como "Remove once
  root-caused". A causa raiz exata da anomalia original de frete
  (R$18.944 num pedido real) nunca foi 100% confirmada por esse log —
  os fixes de `base_price` e do prompt explicaram sintomas
  relacionados, mas não necessariamente o caso exato. Remover quando
  root-caused de verdade, ou manter de propósito se quiser
  visibilidade contínua.
- [ ] **Aba Configurações no `/admin`** — última fatia dos prints de
  referência (2 telas de accordion) ainda não avaliada. Precisa
  separar o que é config de nível de plataforma de verdade do que já
  existe por conta em `/settings`, antes de desenhar o escopo.
- [ ] **Painel `/admin` — melhorias menores possíveis** (não
  compromissadas, só anotadas): busca/filtro na aba Financeiro por
  texto livre já existe; poderia ganhar export CSV. Aba Planos não
  tem exclusão definitiva (intencional — fatura/conta referenciam o
  plano).

## Feitas

### 2026-08-11 — Data/dia da semana no prompt (fix de plataforma) + avaliação do prompt da Concórdia

- Revisão pedida pelo dono da conta: prompt customizado + base de
  conhecimento da Concórdia. Achado real de plataforma (não só dessa
  conta): perguntas respondidas direto da base de conhecimento (não
  via ferramenta) não tinham como a IA saber que dia é hoje — corrigido
  injetando "Today is <dia>, <data>" no fuso da própria conta em todo
  prompt (`buildSystemPrompt`).
- Conferido: preço de marmita/rodízio por dia da semana no catálogo de
  produtos bate 100% com a base de conhecimento (`day_price_overrides`
  já é usado corretamente em todo lugar que cobra) — falso alarme
  inicial meu, sem bug aqui.
- Achado sem mexer (é conteúdo do cliente, não código): a seção "APÓS
  CONFIRMAR" do prompt nunca tem efeito — a mensagem de confirmação
  real é sempre a determinística do sistema, nunca o texto livre da
  IA. Reportado ao dono, não alterei o prompt.
- Achado cosmético sem mexer: dois produtos no catálogo com nome
  digitado diferente da base de conhecimento ("saborisada" vs
  "saborizada", "Refriigerante" com i duplo) — preço bate certo,
  impacto baixo (IA normalmente vê o cardápio inteiro, não busca por
  nome exato).

### 2026-08-11 — Quantidade implícita no pedido + bairro com erro de ortografia

- Prompt reforçado: números por extenso/artigo indicando quantidade
  ("uma", "um", "dois", "duas"...) agora contam como quantidade dada —
  a IA não deve mais perguntar de novo só porque não veio um dígito.
  Confirmado ao vivo: cliente disse "faz uma p pra mim" e a IA
  perguntou a quantidade da marmita P mesmo assim.
- `matchNeighborhood` agora tolera erro de ortografia de verdade (não
  só acento/maiúscula/rótulo "Bairro", que já tinha sido corrigido
  ontem) — cai pra distância de edição (Levenshtein) quando não há
  match exato, com limite proporcional ao tamanho do nome e recusa
  quando dois nomes cadastrados ficam igualmente próximos (não
  adivinha, prefere pedir de novo a cobrar a zona errada).

### 2026-08-10 — Transcrição de áudio via OpenRouter + fix de casamento de bairro

- Transcrição de áudio agora aceita OpenRouter como provedor (além de
  Groq/OpenAI) — lançado por eles em 22/07/2026, mesmo formato
  multipart da OpenAI. Quando a conta já usa OpenRouter como provedor
  principal do chat, a transcrição reaproveita a mesma chave
  automaticamente, sem precisar cadastrar uma nova. Migration 072.
  (Concórdia especificamente: o Eder vai trocar o provedor de
  transcrição dela pra OpenRouter por conta própria — não mexi.)
- Fix: casamento de bairro não reconhecia quando o cliente respondia
  com o rótulo junto ("Bairro Santo Onofre" em vez de só "Santo
  Onofre") — confirmado ao vivo num pedido real da Concórdia que
  acabou cancelado por causa disso. `normalizeName` agora remove esse
  prefixo antes de comparar.

### 2026-08-10 — Incidente: IA parada na Churrascaria Concórdia

- Diagnóstico ao vivo (produção): `auto_reply_max_per_conversation`
  configurado em 3 é baixo demais pra um pedido real — toda conversa
  que passa de 3 respostas da IA para silenciosamente, sem nenhum
  aviso visível. 84 de 250 conversas pendentes da conta estavam
  travadas assim (60 já formalmente "handoff", 24 no limite sem nem
  isso), nenhuma atribuída a humano, acumulado desde 06/08.
- Mitigação aplicada (confirmada com o dono da conta antes): limite
  subido de 3 → 15; as 84 conversas travadas foram destravadas em
  massa (mesmo efeito do botão "Retomar IA" do inbox, uma por uma,
  só que via SQL direto). Confirmado ao vivo: IA voltou a responder
  minutos depois.
- Gaps reais descobertos nessa investigação → ver seção Pendentes
  (sinal visual de "IA pausada" no inbox, valor padrão do limite,
  contato "Presente Diário" nunca respondido).

### 2026-08-09 — Painel `/admin` completo (v0.10.0)

- Aba **Dashboard**: stats da plataforma inteira (contas, usuários
  online, conexões WhatsApp, conversas, contatos, mensagens,
  faturamento) + saúde do servidor (CPU/memória/disco/wuzapi) +
  botão de reiniciar o backend.
- Aba **Financeiro**: faturas de todos os clientes, filtros, 8 cards
  de resumo, ações de marcar paga/cancelar/copiar link.
- Aba **Planos**: CRUD de planos de assinatura (existia como página
  separada, migrado pra dentro do painel com abas).
- Aba **Empresas**: filtro por status/plano/WhatsApp, coluna de
  receita por conta, suspender/reativar e trocar plano direto na
  linha.
- Fix: clique nas abas não respondia (ficava preso em Planos) —
  estado da aba virou local em vez de derivado da URL a cada render.

### 2026-08-09 — Confiabilidade do delivery via IA + Pix (v0.9.1)

- `base_price` do frete "por km" corrigido: era somado à taxa por
  distância, agora é o valor mínimo (piso), não um adicional.
- Bug de casamento de bairro na LocationIQ desde a troca de provedor
  (07/08) — faltava `addressdetails=1` nas chamadas de geocodificação.
- Retentativas da LocationIQ alargadas (500ms/1.2s/2.5s, 3 tentativas).
- Regra "nunca invente um valor, copie da ferramenta" reforçada depois
  do prompt customizado da conta, que podia sobrepor a instrução.
- Fallback de distância em linha reta (+35% de margem) quando o
  provedor de rotas falha, pra nunca mais travar um pedido.
- Chave Pix própria da conta (Configurações → Pagamento), enviada
  automaticamente na confirmação do pedido quando o pagamento é Pix.
- Texto de confirmação alterado: "Em breve confirmamos o seu pedido."
  → "Seu pedido foi enviado para a cozinha."

### 2026-08-08 — Confiabilidade do fluxo de pedidos (v0.9.0)

- Pedido via localização compartilhada do WhatsApp.
- Transcrição de áudio.
- Horário de funcionamento próprio do agente de IA.
- Estado persistente do pedido (corrige linhas duplicadas no
  carrinho, perguntas repetidas, preço desatualizado por falta de
  memória do modelo entre chamadas de ferramenta).

> Para o histórico completo e detalhado de cada versão, ver
> [CHANGELOG.md](./CHANGELOG.md).
