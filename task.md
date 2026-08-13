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
- [ ] **Notinha física nunca foi impressa numa impressora térmica real
  pra validar** — o `zontalk-print-agent.exe` reconstruído (12/08) foi
  testado ponta a ponta contra um servidor falso (fluxo completo +
  falha), mas nenhum byte ESC/POS gerado por ele passou por hardware
  de verdade ainda. O corte de papel (`GS V`) é o comando com maior
  chance de precisar de ajuste pro modelo exato de impressora da
  Concórdia — ver `clients/wacrm/print-agent/README.md`. Confirmar no
  primeiro pedido real após o pareamento do novo `.exe`.

## Feitas

### 2026-08-12 — Cache de prompt (custo de IA)

- Pedido pelo dono da conta: "tem como otimizar tokens? hoje a IA
  consumiu US$1,95". Investigado com dado real (`ai_usage_log`): 206
  chamadas em 24h, 1.522.379 tokens de entrada contra 15.971 de
  saída — 98%+ do custo é contexto reenviado (prompt do sistema + 7
  ferramentas), não resposta gerada. Também achado: a conta usa GPT-5.4
  completo (não o mini) via OpenRouter — repassado ao dono pra decidir
  com o administrador da Concórdia se querem trocar de modelo.
- `buildSystemPrompt` reordenado (conteúdo fixo primeiro, dinâmico
  por último — estado do pedido não fica mais no meio do prompt) +
  `cacheableText` novo no retorno, marcando o prefixo estável.
  Beneficia OpenAI/OpenRouter automaticamente (cache de prefixo
  automático, sem configuração); Anthropic ganhou `cache_control`
  explícito no prompt e nas 7 ferramentas de delivery.
- Fora de escopo por ora: cache do histórico de mensagens dentro de um
  mesmo loop de ferramentas (várias chamadas do mesmo pedido) — ganho
  menor, mais complexo, revisitar se fizer sentido depois.

### 2026-08-12 — Notinha não avisava quando o pedido era retirada

- Perguntado pelo dono da conta ao testar o fix de entrega/retirada
  no prompt: a notinha em si nunca deixava claro que um pedido era
  retirada. Não existe (nunca existiu) coluna `is_pickup` em
  `delivery_orders` — sempre foi inferido por `delivery_address` vir
  `null`, e as duas notinhas (navegador e física) só omitiam a linha
  de endereço nesse caso, sem avisar nada. A física ainda cabeçalhava
  "*** DELIVERY ***" mesmo em retirada.
- Corrigido nas duas: `clients/wacrm/print-agent` (cabeçalho vira
  "*** RETIRADA ***", linha "RETIRADA NO LOCAL" no lugar do endereço)
  e `/delivery/pedidos/[id]/imprimir` (mesma linha explícita). `.exe`
  republicado.

### 2026-08-12 — IA não perguntava entrega/retirada antes do endereço

- Reportado ao vivo: cliente disse "Vou retirar" e a IA já tinha
  pedido o endereço de entrega antes disso — só corrigiu porque o
  cliente avisou por conta própria. Prompt não tinha nenhuma instrução
  pra perguntar entrega/retirada cedo, nem uma lista de como reconhecer
  as várias formas de dizer que vai buscar.
- Corrigido em `buildSystemPrompt` (`src/lib/ai/defaults.ts`): agora
  pergunta entrega/retirada antes do endereço, e reconhece "vou
  retirar", "vou buscar", "vou passar aí", "retiro aí", "pego aí", "no
  balcão" (não só a palavra "retirada" isolada) — para de pedir
  endereço assim que identificar.

### 2026-08-12 — zontalk-print-agent reconstruído do zero + notinha física

- Descoberta durante o fix de forma de pagamento: o código-fonte do
  `zontalk-print-agent.exe` nunca existiu versionado em lugar nenhum —
  foi subido direto pro VPS como binário compilado
  (`.gitignore`'d por ser asset estático grande, mesmo raciocínio de
  qualquer download). Confirmado com o dono: ele mesmo não tem a fonte.
- Reconstruído do zero em `clients/wacrm/print-agent/` (projeto novo,
  com git próprio) — comportamento reverso-engenheirado direto do
  `.exe` compilado (bundle `pkg` preserva o texto do JS quase
  verbatim: nomes de propriedade, strings, texto exato de cada prompt
  do wizard sobreviveram à minificação) e cruzado com uma notinha real
  fotografada. Mesmo formato de `config.json`, mesmo fluxo de
  `--setup`, mesmo contrato de API, as duas formas de impressão (rede
  via IP e USB compartilhado no Windows) — lojas já pareadas devem
  continuar funcionando só trocando o `.exe`, sem refazer o setup.
- Em cima da reconstrução, aplicado o que motivou tudo isso: fonte
  maior (double-height no corpo inteiro), endereço em negrito, e a
  linha de forma de pagamento.
- 24 testes automatizados (renderização ESC/POS, validação de
  config). Testado ponta a ponta contra um servidor HTTP+TCP falso
  (simulando a API do wacrm e uma impressora de rede) — fluxo de
  sucesso e de falha (compartilhamento Windows inexistente) confirmados.
- `.exe` antigo salvo como backup no VPS
  (`zontalk-print-agent.exe.bak-20260812`) antes de publicar o novo.
- Bug real encontrado e corrigido durante o teste: `rl.question()`
  chamado várias vezes na mesma interface do `readline` travava depois
  da primeira pergunta com stdin não-interativo no Windows (reproduziu
  tanto com `node` puro quanto com o `.exe` empacotado — não era coisa
  do `pkg`). Resolvido trocando pro padrão de iterador assíncrono
  (`Symbol.asyncIterator`) do `readline`.
- Ajuste pedido depois: seção OBSERVACOES (nota do pedido inteiro)
  movida pra logo depois dos itens, em vez de ficar no final da
  notinha depois do TOTAL — mais perto do que a cozinha precisa ler
  antes de preparar. `.exe` republicado de novo no mesmo dia.
- Bug real reportado ao vivo: "abro o .exe e ele fecha sozinho" — sem
  `config.json`, o agente só imprimia uma mensagem e saía na hora, e o
  Windows fecha a janela de console de um duplo-clique assim que o
  processo termina, então a mensagem nunca dava tempo de ser lida.
  Corrigido: sem config, entra direto no assistente de configuração em
  vez de só instruir a rodar com `--setup` (que quem clica duas vezes
  no `.exe` não tem como fazer); e qualquer saída com erro agora espera
  Enter antes de fechar (só quando é um terminal de verdade — não trava
  execução automatizada/scriptada). `.exe` republicado de novo.

### 2026-08-12 — Forma de pagamento faltando na notinha impressa de verdade

- A notinha física da Concórdia (impressora térmica) não é a página
  `/delivery/pedidos/[id]/imprimir` que editei ontem — é gerada por um
  executável Windows separado (`zontalk-print-agent.exe`), que puxa o
  recibo de `GET /api/v1/print-jobs` e imprime com o próprio template
  dele. Esse endpoint nunca incluía `payment_method`/`payment_notes`
  no JSON — corrigido.
- **Pendente, fora deste repositório**: fonte maior e endereço em
  negrito na notinha física dependem do template do próprio agente —
  código-fonte não está em `c:\claude` (procurei em todo o diretório,
  não achei nem o `.exe` nem uma pasta `print-agent/`). Precisa
  localizar/abrir esse projeto separadamente pra aplicar essas duas
  mudanças visuais.

### 2026-08-11 — Notinha de impressão + Cardápio do dia + Cardápio na barra lateral

- **Notinha de impressão** (`/delivery/pedidos/[id]/imprimir`): fonte
  maior (corpo `text-sm`→`text-base`, adicionais/obs `text-xs`→
  `text-sm`, nome da conta `text-base`→`text-lg`), endereço em
  negrito, e nova linha com a forma de pagamento que o cliente
  escolheu. Essa última exigiu destravar um gap real: `payment_method`
  não existia como coluna em `delivery_orders` — a IA já capturava a
  informação (`ai_order_info.paymentMethod`) mas nunca salvava no
  pedido. Agora `place_order` repassa pro `finalizeDeliveryOrder`.
- **Cardápio do dia**: novo recurso puramente informativo — o que tem
  no buffet hoje, pra IA recitar quando o cliente pergunta (não afeta
  preço/pedido, isso já é resolvido corretamente por
  `day_price_overrides`). Mesmo padrão do horário de funcionamento da
  IA (texto por dia da semana, `ai_configs.daily_menu`); a IA resolve
  o dia de hoje no fuso da conta e injeta só a linha daquele dia no
  prompt (reaproveita o mecanismo de "hoje é sexta-feira" de ontem).
- **Cardápio promovido a item próprio na barra lateral** — antes só
  existia "Delivery" (leva pra Pedidos); pra chegar em Cardápio era
  preciso entrar em Pedidos e clicar em voltar. Agora tem entrada
  direta logo abaixo de Delivery.
- Consequência da promoção acima: a config do Cardápio do dia passou a
  viver na própria tela de Cardápio (não em Configuração de IA, onde
  não fazia mais sentido morar) — novo endpoint dedicado
  `POST /api/ai/config/daily-menu` (não reaproveitei o
  `POST /api/ai/config` existente: aquele exige provider/model/api_key
  em todo save e reseta os outros toggles quando omitidos — arriscado
  demais pra uma tela que só edita uma coluna).

  > **Migrations required:** aplique
  > `supabase/migrations/073_delivery_payment_method.sql` e
  > `supabase/migrations/074_ai_daily_menu.sql`. Ambas idempotentes.

### 2026-08-11 — `search_menu` não achava produto por acento/frase inteira

- Causa raiz real do "a IA não consegue consultar a base de
  conhecimento" reportado pelo dono da conta: não era a base de
  conhecimento, era a busca de produto. `search_menu` usava
  `.ilike('name', '%termo%')` — sensível a acento (sem extensão
  unaccent no Postgres) e exige a frase inteira como substring
  contígua. "Rodizio de Carne" (sem acento) no catálogo nunca batia
  com "rodízio" (com acento) na pergunta do cliente/modelo, e uma
  busca de 3 palavras ("rodízio quilo almoço") também falhava porque
  nenhum produto tem as três juntas no nome.
- Corrigido: normalização (remove acento + minúsculas) e casamento por
  palavra (≥3 caracteres) em vez de substring inteira, filtrando em
  JS depois de um fetch mais largo em vez de `ILIKE` no banco.
  Commit `4fb00aa`.

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
