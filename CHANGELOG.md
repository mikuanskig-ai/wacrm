# Changelog

> Este arquivo é sempre escrito em português.

## [0.20.0] — 2026-09-01

### Adicionado

- **Etiqueta automática pra quem faz pedido** — pedido do dono da
  conta: "adicionar a opção da IA adicionar uma tag nos contatos que
  fizeram os pedidos". Implementado como efeito colateral
  **determinístico** da criação do pedido (`finalizeDeliveryOrder`),
  não como uma ferramenta que a IA decide quando chamar — mesmo
  raciocínio já aplicado essa semana em `place_order`/`cancel_order`:
  algo que a IA precisa lembrar de fazer é algo que ela pode esquecer
  de fazer. Como todo pedido (IA no WhatsApp, manual, Flow builder,
  cardápio público) já passa por essa mesma função, a etiqueta é
  aplicada não importa a origem, sem depender do comportamento do
  modelo.
  - Nova configuração em **Configurações → Etiqueta de pedido**
    (só aparece com o módulo Delivery ativo): escolhe qual etiqueta já
    cadastrada usar, ou deixa "Nenhuma" pra desativar — não cria
    etiqueta nova sozinho, usa as que a conta já tem em Campos e tags.
  - Reaproveita o escritor central de tag já usado pelo Flow builder
    (`addContactTagAndDispatch`) — mesmo efeito colateral de automação
    (`tag_added`) que uma tag colocada por fluxo já dispara.
  - Nunca bloqueia a venda: falha ao aplicar a etiqueta é só logada,
    o pedido é criado normalmente mesmo assim.
  - Migration 075 (`accounts.order_placed_tag_id`, já aplicada em
    produção) + novo endpoint `GET/POST /api/delivery/order-tag-config`.
  - 9 testes novos (4 em `create-order.test.ts`, 5 na rota).

## [0.19.0] — 2026-09-01

### Corrigido

- **Pedido duplicado cancelado ainda saía impresso duas vezes na
  cozinha** — reportado ao vivo (Concórdia, print do painel): a IA
  duplicou um pedido (mesmo cliente, mesmo valor), um foi cancelado no
  sistema — mas o painel mostrar "cancelado" não desfaz o que já saiu
  na impressora. Confirmado no banco: os dois pedidos já tinham
  `print_jobs` com status `printed` antes do cancelamento — a cozinha
  recebeu duas notinhas idênticas, sem nenhuma marcação de qual era a
  válida, e preparou os dois.
  - Nova `notifyOrderCancellation()` (`src/lib/delivery/print-queue.ts`):
    ao cancelar um pedido, se ele já tinha uma notinha `printed`,
    enfileira uma nova impressão pra esse mesmo pedido — a notinha já
    impressa não tem como ser "desimprimir", só uma nova avisando.
    Pedido que ainda estava `pending` (nunca chegou a imprimir) não
    precisa disso — a rota `GET /api/v1/print-jobs` já tinha
    auto-cura pra esse caso (marca `skipped` em vez de servir),
    achado conferindo o código antes de escrever a correção.
  - Aplicado nos dois lugares que cancelam pedido: a tool `cancel_order`
    da IA e o PATCH manual (`/api/delivery/orders/[orderId]`, o botão
    "Cancelar pedido" do painel).
  - **Notinha do navegador** (`/delivery/pedidos/[id]/imprimir`) e **o
    agente de impressão térmica** (projeto separado,
    `zdelivery-print-agent`) ganharam faixa "❌ PEDIDO CANCELADO ❌" /
    "NAO PREPARAR ESTE PEDIDO" bem no topo da notinha, antes até do
    nome da conta, quando o pedido está cancelado.
  - **`.exe` do agente de impressão republicado**
    (`v2.zontalk.shop/downloads/zontalk-print-agent.exe`, backup do
    anterior salvo como de praxe) — mas **cada loja com o agente já
    instalado precisa baixar e trocar o `.exe` na mão** pra ganhar essa
    faixa (sem auto-update, limitação já conhecida). Até lá, a notinha
    de reimpressão vai imprimir sem a faixa nova.
  - 3 testes novos em `print-queue.test.ts`, 2 no repositório do
    agente de impressão (`receipt.test.ts`).
- Causa raiz da duplicação em si (por que a IA criou um segundo
  pedido) **não foi resolvida aqui** — investigação aponta uma
  mensagem de acompanhamento do cliente ("E Silvana Mendes", só
  informando quem ia fazer o Pix) sendo mal interpretada como pedido
  de um segundo pedido, apesar do prompt já instruir cancelar antes de
  recriar. Anotado em `task.md` como gap em aberto — esse fix cobre a
  consequência (impressão dupla), não a causa.

## [0.18.0] — 2026-09-01

### Corrigido

- **IA inventou horário de funcionamento (e preço de rodízio) que não
  existem** — reportado ao vivo pelo Eder (Concórdia): cliente
  perguntou sobre rodízio no fim de semana, a IA ofereceu passar valor
  e horário, cliente respondeu só "Pode ser" e depois só "Sim" — e a
  IA respondeu com um valor de rodízio (R$55) e um horário (almoço +
  jantar 18h-23h todos os dias) que não batem com **nada**: nem com a
  base de conhecimento (preços reais variam por dia, R$54,90 a
  R$84,90; horário real é só 11h-14h, todos os dias, sem jantar — um
  bar de terceiros usa o espaço à noite), nem com a config de horário
  da IA. Um atendente humano teve que entrar na conversa e corrigir na
  hora.
  - Causa raiz: a busca na base de conhecimento (`retrieveKnowledge`)
    usava só a última mensagem do cliente como texto de busca — e
    "sim"/"pode ser" não tem nenhuma palavra em comum com "HORÁRIOS"
    ou os documentos de preço, então a busca não achava nada relevante
    pra nenhuma das duas perguntas. Sem nenhum trecho da base injetado
    no prompt, a IA inventou uma resposta plausível em vez de admitir
    que não tinha a informação — mesmo já existindo instrução no prompt
    pra nunca inventar fato sem base.
  - Corrigido: nova `retrievalQueryText()` (`src/lib/ai/query.ts`) —
    busca agora usa a mensagem do cliente **junto com** a mensagem
    anterior da própria IA (é ela que carrega o assunto real quando o
    cliente só confirma). Aplicado nos 3 lugares que buscam a base de
    conhecimento (resposta automática, rascunho, playground) —
    fonte única, não duplicada.
  - 3 testes novos, incluindo o caso exato do incidente.

## [0.17.1] — 2026-08-30

### Corrigido

- **Tela de "confirme seu e-mail" travava conta nova sem necessidade**
  — testado ao vivo pelo dono da conta no `/signup`. Investigado antes
  de mexer: o Supabase self-hosted desse VPS já está com
  `GOTRUE_MAILER_AUTOCONFIRM=true` (confirmado no `.env` de
  `/opt/supabase-selfhost`) — ou seja, **nenhum e-mail de confirmação
  é enviado**, a conta já vem confirmada e com sessão ativa direto do
  `signUp()`. O bug era só no front: `signup/page.tsx` sempre mostrava
  a tela "Confira seu e-mail" depois de qualquer `signUp()` bem
  sucedido, sem checar se já veio uma sessão ativa — ninguém precisava
  clicar em nada, mas a tela dizia que precisava.
  - Corrigido: quando `signUp()` já devolve `session` (o caso de
    verdade nesse deploy), pula direto pro app — mesma navegação de
    página inteira que o `/login` já usa depois de autenticar (não
    `router.push`, pra garantir que o middleware veja o cookie novo já
    na próxima requisição). Só mostra "Confira seu e-mail" no caso
    (hoje inativo) de `GOTRUE_MAILER_AUTOCONFIRM` vir a ser desligado.
  - **Não mexi na configuração do Supabase** — essa instância é
    compartilhada com outros produtos do dono da conta no mesmo VPS
    (pelo menos o Zontalk CRM também roda em cima dela); mudar
    `GOTRUE_MAILER_AUTOCONFIRM` ali afetaria todos eles, não só o
    zdelivery. O fix ficou 100% no app.

## [0.17.0] — 2026-08-30

### Adicionado

- **Landing page em v2.zontalk.shop ("/")** — antes a raiz do domínio
  do app só redirecionava direto pro login, sem nenhuma explicação da
  plataforma. Agora visitante anônimo vê uma landing de verdade
  (hero, "como funciona", recursos, chamada pra plano, CTA final);
  visitante já logado continua indo direto pro `/dashboard` como
  antes. Não substitui a LP que já existe em zontalk.shop (projeto
  separado, outro domínio) — essa é a landing do próprio domínio do
  app.
  - Ângulo: lidera com a IA que atende no WhatsApp e monta o pedido
    sozinho (o que o dia inteiro de hoje foi construir/blindar), CRM
    completo (inbox compartilhada, funil, disparo em massa,
    automações) aparece como a plataforma por trás. Menciona também o
    fluxo determinístico por botão do Flow Builder como alternativa
    pra quem não quer depender de IA.
  - Sem depoimento/prova social — decisão consciente, sem citação real
    autorizada ainda pra usar.
  - `src/middleware.ts` ganhou um novo bloco: usuário autenticado em
    `/` → redireciona pro `/dashboard` (igual antes); anônimo → passa
    direto, sem redirect nenhum (`/` nunca esteve em `protectedPaths`).
  - `src/app/page.tsx` virou a landing de verdade — Server Component,
    `generateMetadata` com `title`/`description`/`robots:
    {index:true, follow:true}` (mesmo padrão de override que
    `/pricing/layout.tsx` já usa contra o `{index:false, follow:false}`
    global do layout raiz).
  - 7 componentes novos em `src/components/landing/` (header, hero,
    como-funciona, recursos, chamada de preço, CTA final, rodapé) —
    todos Server Component com `getTranslations` (não `useTranslations`
    client-side, diferente do resto do app) pra HTML já pronto sem JS
    extra, melhor pra SEO/compartilhamento.
  - Novo namespace `Landing` em `messages/{pt,en,ko}.json`.
  - 2 testes novos em `middleware.test.ts` (autenticado redireciona,
    anônimo passa direto).
  - **Fora de escopo, sinalizado conscientemente**: sem Open
    Graph/imagem de compartilhamento (não existe em nenhuma página do
    app hoje — vai aparecer "quebrado" ao compartilhar em redes/
    WhatsApp, mas não bloqueia essa entrega); sem sitemap.ts/robots.ts
    dinâmico (não existe hoje, único sinal de SEO por rota é o
    `metadata.robots` de cada página).

## [0.16.0] — 2026-08-28

### Adicionado

- **Passo de quantidade no `add_order_item` do Flow Builder** — nó
  determinístico de pedido por menu numerado (sem IA, sem risco de
  duplicar/perder item) até agora só sabia adicionar 1 unidade por
  vez; pra pedir 2x era preciso escolher o mesmo produto duas vezes,
  virando duas linhas separadas de 1x em vez de uma linha de 2x. Agora,
  depois de escolher o produto (e resolver os adicionais, se tiver),
  pergunta "quantas unidades?" antes de fechar a linha do carrinho.
  Mesmo limite de 20 do `add_to_cart` da IA (`tools/delivery.ts`), pra
  manter um teto consistente em todo o app.
  - Implementado em `engine.ts` (motor real) e espelhado em
    `simulate.ts` (simulador do editor de fluxo, que reimplementa a
    mesma máquina de estado só que em memória, sem tocar o banco) —
    os dois precisavam mudar juntos ou o simulador ficaria mostrando
    um comportamento diferente do que realmente acontece no WhatsApp.
  - Aproveitei pra corrigir a documentação desatualizada do tipo
    `AddOrderItemNodeConfig` (ainda falava em "lista interativa
    tocável" e limite de 10 da Meta — isso foi removido faz tempo
    quando o canal migrou pra wuzapi/whatsmeow, que não tem
    equivalente; hoje é tudo texto numerado simples, confirmado lendo
    o código de `sendNumericMenuAndSuspend`).
  - 3 testes novos em `simulate.test.ts` (pergunta quantidade sem
    adicional, reflete no total com >1 unidade, clampa em 20).
  - **Nota honesta**: o motor real (`engine.ts`) não tem teste unitário
    dedicado pro `add_order_item` — isso já era assim antes dessa
    mudança (nenhum teste existente cobria `handleAddOrderItemReply`/
    `finishAddOrderItem`/`dispatchInboundToFlows`), só o simulador
    tinha cobertura. A lógica nova no motor espelha exatamente a do
    simulador (mesmas constantes, mesmos ramos), mas não é a mesma
    coisa que testar o motor de verdade.

## [0.15.0] — 2026-08-28

### Adicionado

- **Carrinho abandonado é limpo automaticamente** — pedido direto do
  dono da conta depois de um segundo caso no mesmo dia (Fernanda: pediu
  "uma marmita P sem macarrão", a IA confirmou 3 itens — 2 deles
  fantasmas, de uma sessão de dias atrás nunca finalizada). A trava de
  6h já impedia a soma errada (caso do Ezequiel), mas não impedia
  itens de dias diferentes simplesmente ficarem juntos no carrinho pra
  sempre — essa é a correção geral por trás dos dois casos pontuais de
  hoje.
  - Novo `GET /api/delivery/cron` (mesmo padrão de
    `/api/automations/cron` e `/api/flows/cron`: secret via
    `x-cron-secret`, reaproveita `AUTOMATION_CRON_SECRET`). Rodando a
    cada 5 minutos, zera (`ai_cart = []`) qualquer conversa cujo
    carrinho não teve NENHUMA linha tocada nas últimas 6h — mesmo
    limiar que a trava de merge já usa, agora exportado de
    `create-order.ts` como fonte única (`isStaleCartLine`,
    `isCartAbandoned`) em vez de duplicado.
  - Só limpa carrinho de verdade abandonado — uma única linha recente
    já é suficiente pra NÃO mexer em nada (nunca interrompe um pedido
    em andamento). `ai_order_info` (nome, endereço, pagamento) não é
    tocado — permanece útil pro próximo pedido.
  - Escolhido varredura a cada 5 min em vez de "zerar à meia-noite":
    não depende do fuso de cada conta, não corre risco de apagar um
    pedido em andamento bem na virada do dia, e limpa o carrinho
    abandonado muito mais rápido (minutos, não até a próxima
    meia-noite).
  - 8 testes novos (`isStaleCartLine`/`isCartAbandoned` em
    `create-order.test.ts`, rota em `cron/route.test.ts`).
  - **Requer configuração no VPS**: `*/5 * * * * curl -H
    "x-cron-secret: ..." https://v2.zontalk.shop/api/delivery/cron` no
    crontab do servidor (mesmo secret já usado pelos outros crons).

## [0.14.0] — 2026-08-28

### Corrigido

- **`add_to_cart` fundia com linha de dias atrás e dobrava a
  quantidade** (Ezequiel, cliente quase diário de "marmita média pro
  meio-dia" — 28/08). O carrinho de uma sessão abandonada (sem
  `place_order`, nunca resetado) ficava com uma linha fantasma de dias
  atrás; na próxima visita, o cliente naturalmente menciona o produto
  de novo ("queria pedir uma marmita média") — o que já era o
  suficiente pra trava de 26/08 (`customerMentionedProductSince`)
  aprovar a soma, mesmo sem ligação nenhuma com a linha antiga. 1
  marmita pedida virou 2 no resumo.
  - Nova trava: linha de carrinho com mais de 6h nunca funde por soma
    — vira sempre uma linha nova, **mesmo** com `confirm_quantity_increase`
    ou uma mensagem do cliente citando o produto. Linha sem `addedAt`
    (dado legado, anterior a esse campo existir) também conta como
    velha demais — antes isso pulava a trava por completo.
  - 2 testes novos (linha velha com/sem `addedAt`); os 3 testes
    existentes de merge/bloqueio ajustados pra usar timestamp relativo
    (`Date.now() - Xms`) em vez de data fixa — senão eles mesmos
    ficariam "velhos" e quebrariam sozinhos com o tempo.

## [0.13.0] — 2026-08-28

### Adicionado

- **Ícone de revisar/imprimir pedido no cabeçalho da conversa** —
  antes só aparecia no banner "IA pausada" (só quando o bot já tinha
  travado/passado pro humano). Confirmado ao vivo (Edemar, 28/08): o
  bot pode ficar "ativo" o tempo todo, com o carrinho certo montado,
  mas nunca chamar `place_order` — sem handoff, o banner nunca mostra
  o botão. Agora o ícone (clipboard) fica no cabeçalho de qualquer
  conversa com o módulo Delivery ativo, disponível a qualquer momento,
  independente do estado da IA.

### Corrigido

- **Botão de imprimir do painel de detalhe do pedido ficava embaixo do
  X de fechar** — os dois disputavam o mesmo canto superior direito;
  o X (absolutamente posicionado pelo componente Sheet) ficava por
  cima e tornava o botão de imprimir inclicável. Cabeçalho agora
  reserva espaço (`pr-10`) pro X.
- **Pedido completo numa mensagem só podia nunca virar pedido de
  verdade** (Edemar, 28/08 — cliente mandou itens + nome + horário de
  retirada tudo numa mensagem; a IA anotou o carrinho certo, respondeu
  confirmando o horário, mas nunca mostrou o total nem pediu
  confirmação — então nunca chamou `place_order`, nada foi impresso,
  e como a IA não alucinou nem travou de verdade, não houve handoff
  pro humano perceber). Prompt reforçado: mesmo quando tudo chega
  numa mensagem só, a resposta daquele mesmo turno precisa mostrar o
  carrinho com total e pedir confirmação explícita antes de
  `place_order` — nunca só confirmar de forma solta ("anotei") sem
  total nem pergunta.
  - `ai_cart` da conversa do Edemar ficou com linhas fantasmas
    acumuladas desde 26/08 (nunca limpas por falta de `place_order`);
    o pedido real dele já tinha sido criado manualmente pelo atendente
    antes desse ícone existir. Limpeza do carrinho pendente de
    confirmação (é gravação direta em produção).

## [0.12.0] — 2026-08-27

### Adicionado

- **Sistema de confirmação de pedido pelo atendente** — quando a IA
  para de responder numa conversa (por qualquer motivo: alucinação
  detectada, erro, decisão do próprio modelo), o que ela já tinha
  anotado (carrinho, endereço, forma de pagamento) não precisa mais
  ser perdido ou redigitado do zero. No banner "IA pausada" agora
  aparece um botão **"Revisar pedido da IA"** que abre uma tela de
  revisão: itens editáveis (quantidade, remover), endereço/retirada,
  forma de pagamento, taxa de entrega, observação geral, subtotal e
  total calculados na hora. Confirmando, cria o pedido de verdade
  (mesma função que o `place_order` da IA usa) e **força o envio pra
  impressão** — resolve direto o "não está imprimindo" quando a causa
  é a IA ter travado sem nunca chamar `place_order`.
  - Novo endpoint `GET/POST /api/conversations/[id]/ai-order`.
  - Novo componente `AiOrderConfirmDialog`, integrado ao
    `AiThreadBanner`.
  - 6 testes novos no endpoint.
  - Só aparece quando o módulo Delivery está ativo e a conversa está
    pausada — não aparece com a IA ainda respondendo.

### Corrigido

- **Item perdido em silêncio no `add_to_cart`** (Fernanda Mendonça,
  27/08 — achado investigando o caso do "pedido confirmado" falso
  dessa mesma conversa). Cliente listou 3 marmitas numa mensagem só (1
  lisa, 1 sem macarrão, 1 grande), mas o carrinho real ficou só com 2
  — a lisa nunca entrou. Causa: a lógica de "o cliente está só
  detalhando o item que já pediu" (criada em 07/08 pra um caso
  diferente) tratou a segunda marmita como se fosse nota da primeira,
  sobrescrevendo em vez de criar uma linha nova.
  - Essa lógica agora só roda com sinal explícito do modelo
    (`attach_note_to_existing: true`) — o padrão passa a ser **não
    fundir** (cria linha nova), porque perder um item em silêncio é
    pior do que uma linha a mais e visível (correção fácil por
    `update_cart_item` ou pela nova tela de revisão acima). Prompt
    também reforçado com o caso concreto.
  - 1 teste novo confirmando que sem o sinal explícito nada se perde;
    o teste de 07/08 original passa a exigir o sinal explícito.
- **Hotfix de deploy do mesmo dia**: a nova rota `ai-order` foi criada
  como `[id]/ai-order`, mas já existia `[conversationId]/attendance`
  no mesmo nível — o Next.js exige o mesmo nome de parâmetro dinâmico
  em todas as rotas de um mesmo nível, e isso derrubou `/login` (500)
  por ~1 minuto até o restart seguinte. `npm run build` não pega esse
  erro (só aparece com o servidor realmente respondendo request).
  Corrigido renomeando a rota pra `[conversationId]/ai-order`.
  Verificação passou a incluir `npm start` local + curl antes de
  reenviar, não só o build.

## [0.11.4] — 2026-08-27

### Corrigido

- **4ª ocorrência do "pedido confirmado" falso — dessa vez sem preço
  nenhum na mensagem, passou batido pela trava anterior** (Concórdia —
  Fernanda Mendonça). A trava de código de 0.11.2 só disparava quando
  a mensagem tinha "Total" perto de um valor; essa aqui foi só "Pedido
  confirmado! 🎉 Já estou passando para a cozinha." — sem preço, sem
  `place_order` ter sido chamado, sem pedido nem impressão criados.
  - Nova trava, complementar: reivindicar que o pedido foi confirmado/
    está indo pra cozinha, sem `place_order` ter sido chamado de
    verdade nessa resposta, **é sempre mentira** — não precisa checar
    carrinho pra saber disso (a única forma legítima do cliente ouvir
    isso é a confirmação determinística que já existe, com outra
    redação: "Pedido recebido... enviado para a cozinha"). Frase
    específica ("pedido confirmado", "passando/indo pra cozinha") pra
    nunca travar um "endereço confirmado 😊" legítimo no meio da
    conversa.
  - Mensagem de aviso interno pro atendente generalizada (não fala
    mais só de "carrinho vazio", já que cobre os dois casos).
  - 2 testes novos (bloqueia a reivindicação falsa; não bloqueia a
    confirmação determinística real nem um "confirmado" solto sem
    relação com pedido).

### Encontrado, ainda não corrigido

- **Carrinho da Fernanda estava faltando 1 item**: ela pediu 3
  marmitas (1 M lisa, 1 M sem macarrão, 1 G), mas o carrinho real só
  tinha 2 linhas — a M lisa nunca entrou. Suspeita: o
  `refinementMatchIndex` de `add_to_cart` (feito originalmente pra
  "cliente detalha o item que acabou de pedir numa mensagem separada")
  está confundindo isso com "cliente pediu um segundo item do mesmo
  produto, mas customizado diferente" — e faz a linha nova
  *sobrescrever* a existente em vez de criar uma segunda linha,
  perdendo um item em silêncio. Precisa de investigação própria antes
  de mexer — é o oposto do bug de duplicação (aqui alguém pode ficar
  sem receber o que pagou), e a lógica de match já foi ajustada com
  cuidado várias vezes este mês.

## [0.11.3] — 2026-08-21

### Adicionado

- **Nova ferramenta `update_cart_item`** — a IA agora consegue reduzir
  quantidade ou remover uma linha do carrinho de verdade. Antes só
  existia `add_to_cart` (que só soma); quando o cliente corrigia um
  pedido pra menos, a IA identificava certo o que precisava mudar mas
  não tinha como agir — confirmado ao vivo (20/08, Concórdia, Fabiane):
  cliente confirmou "sim, apenas uma", a IA nunca executou a correção e
  a conversa ficou parada até fechar o horário, pedido perdido.
  - Identifica a linha por **posição** (`line_number`, 1-based, igual
    ao que `view_cart` já mostra) — não por `product_id`, porque o
    mesmo produto pode legitimamente estar em duas linhas diferentes
    com observações diferentes (exatamente o caso da Fabiane).
  - `view_cart` e o bloco "Order so far" (prompt) agora numeram as
    linhas, pra ferramenta ter como referenciar.
  - Prompt reforçado: usar `update_cart_item` (nunca `add_to_cart`) pra
    correção, e **executar a correção na mesma resposta** assim que o
    cliente confirmar — não só perguntar e parar.
  - 6 testes novos.
- Essa é a parte 1 do plano de duas etapas discutido. Parte 2 (mudar a
  semântica do `add_to_cart`) fica **em espera**: o Ederson já subiu,
  em paralelo, um fix mais cirúrgico pra mesma causa raiz — `add_to_cart`
  agora só soma automaticamente num match exato se alguma mensagem do
  cliente desde então realmente menciona o produto de novo (ou o
  modelo confirma explicitamente via `confirm_quantity_increase`);
  caso contrário avisa e não soma. Mesclado sem conflito nesta sessão.

### Corrigido (via merge do GitHub — trabalho do Ederson Marques)

- `add_to_cart` não soma mais silenciosamente num re-add sem nenhuma
  evidência na conversa de que o cliente pediu mais (5º incidente ao
  vivo confirmado, Lucas Claro 26/08).
- `place_order`'s `notes` ganhou descrição explícita pra parar de
  duplicar a forma de pagamento e a observação de item na notinha
  (Laurete Rocha De Lima, 23/08).
- Notinha de impressão (página do navegador): adicionais/observação
  agrupados visualmente por item, regra tracejada entre itens,
  observação geral movida pro fim em bloco próprio, mais data/hora,
  canal e telefone do cliente, checkbox de conferido/embalado.
  **Pendente**: o agente de impressão térmica (`zdelivery-print-agent`)
  não recebeu o mesmo ajuste ainda.
- As 5 falhas de teste de timezone/locale que persistiam a sessão
  inteira foram corrigidas (dependiam do timezone/locale da máquina
  local, não da CI).

## [0.11.2] — 2026-08-19

### Adicionado

- **Trava de código contra resumo de pedido inventado** (Churrascaria
  Concórdia — Juan, mesmo dia). Terceira ocorrência confirmada ao vivo
  (Francisco e Ederson em 17/08, agora Juan) do mesmo padrão: a IA
  monta um resumo de pedido inteiro convincente — itens, subtotal,
  taxa, total, "Posso confirmar?" — sem NUNCA ter chamado
  `add_to_cart` nem `calculate_delivery_fee`. No caso do Juan: cliente
  pediu 1 marmita G, IA confirmou certo ("Anotei 1 marmita G"), mas o
  resumo final inventou "2 marmitas G — Subtotal R$56 — Total R$64".
  Cliente percebeu ("É só uma marmita 😂"). `ai_cart` no banco: `[]`
  (nunca foi tocado) — não é duplicação de item, é resumo fabricado do
  zero.
  - Reforço de prompt sozinho (0.10.12, 0.10.13) não impediu essa
    variação nova aparecer — desta vez é uma trava de código
    determinística: depois que a IA gera a resposta, se o texto tem
    "Total" perto de um valor em dinheiro E o carrinho real está vazio
    no banco, a mensagem é **bloqueada antes de ir pro cliente** e a
    conversa passa pra um humano, com um aviso interno específico
    (🚨) explicando o motivo — em vez de mandar o número inventado.
  - Cuidado para não travar o caso legítimo: só dispara com a palavra
    "Total" (não qualquer preço — cotação de cardápio tipo "P: R$20,
    M: R$25, G: R$28" passa direto) E carrinho vazio checado DEPOIS do
    turno (se a IA chamou `add_to_cart` de verdade nesse mesmo turno,
    não bloqueia).
  - Novo helper `hasCartItems` (`order-state.ts`), novo motivo de
    handoff `hallucinated_summary` (`handoff.ts`). 3 testes novos em
    `auto-reply.test.ts`.
  - **Não impede a IA de tentar de novo depois** — só impede que ESSA
    mensagem específica, com número inventado, chegue ao cliente.

## [0.11.1] — 2026-08-19

### Corrigido

- **IA não achava a taxa do bairro "Guarujá" mesmo com o bairro
  cadastrado e com preço certo** (Churrascaria Concórdia — Sirlei).
  Cliente disse "jardim Guarujá" logo no início; bairro cadastrado é
  só "Guarujá" (R$15). A IA perguntou o bairro de novo 3 vezes — mesmo
  depois da cliente responder "Bairro Guarujá" explicitamente — e o
  pedido acabou cancelado ("não precisa mandar"). Atendente humano
  interveio na mão, mas cobrou R$20 (não bate com o R$15 cadastrado).
  - Confirmado por que: `matchNeighborhood` (`fee-engine.ts`) só tinha
    match exato ou correção de erro de digitação por distância de
    edição — "jardim Guarujá" está 7 edições de "Guarujá" (a palavra
    inteira "jardim "), longe do limite de tolerância a erro de
    digitação. "Jardim"/"Vila"/"Parque" como prefixo de localidade é
    português coloquial normal — mas ao contrário de "bairro", às
    vezes É parte do nome oficial (essa mesma conta tem "Jardim
    Veredas" e "Jardim Itália" cadastrados), então não dá pra
    simplesmente cortar o prefixo como já é feito com "bairro".
  - Corrigido com um novo nível de match: se o nome cadastrado aparece
    inteiro dentro do que o cliente disse (ou vice-versa), e só existe
    UM cadastro assim — casa. Dois cadastros que colidiriam nesse
    critério continuam caindo em "não encontrado" (nunca chuta).
  - **Também**: quando nada casa automaticamente, a ferramenta agora
    devolve pra IA até 3 nomes cadastrados parecidos, pra ela oferecer
    como opção ("Você quis dizer X?") em vez de repetir a mesma
    pergunta sem informação nova — foi exatamente esse loop que
    cansou a cliente e perdeu a venda.
  - Log de diagnóstico adicionado em todo `neighborhood_not_found`
    (nome tentado + sugestões), e a descrição da ferramenta reforçada
    pra IA sempre passar o bairro dito separadamente no campo
    `neighborhood`, não só embutido no endereço.
  - **Sem garantia de cobrir toda variação de como alguém descreve um
    bairro** — o log novo é o que faltava pra confirmar com certeza a
    próxima vez que algo parecido acontecer.

## [0.11.0] — 2026-08-17

### Adicionado

- **Página de Pedidos: coluna de data/hora e filtro de período** —
  popover com atalhos (Hoje/Ontem/Semana passada/Essa semana/30 dias/
  90 dias) + calendário de intervalo personalizado, filtrando direto
  no banco (`react-day-picker`, novo `order-date-range-filter.tsx` e
  `ui/calendar.tsx`).
- **Detalhe do pedido** agora mostra também data/hora, forma de
  pagamento e observação de pagamento (já existiam no registro, nunca
  apareciam na tela).

### Mudado

- **Pedido novo agora nasce como `confirmed`**, não mais
  `pending_confirmation` — a nota de impressão pra cozinha já dispara
  sempre, independente do status, então o passo extra de "aguardando
  confirmação" ficava sem função real antes de o pedido sequer
  aparecer como confirmado na lista. `pending_confirmation` continua
  válido (pedidos antigos, o CHECK do banco, `STATUS_FLOW`) — só deixa
  de ser onde um pedido novo começa.

Implementado por Ederson Marques (branch `feat/pedidos-page-filters`,
tag `v10`), revisado e mergeado nesta sessão — verificação completa
(tsc/eslint/vitest/build) refeita antes do merge, tudo limpo.

## [0.10.13] — 2026-08-17

### Corrigido

- **Pedido fantasma: IA confirmava "já indo pra cozinha" sem nunca criar
  o pedido** (Churrascaria Concórdia — Francisco e Ederson, mesma manhã).
  Achado ao investigar reclamação de "não está imprimindo": a fila de
  impressão em si estava 100% saudável (37/37 impressos nos últimos 5
  dias, agente conectado e ativo na hora da reclamação) — o problema
  era anterior a isso, o pedido nunca chegava a ser criado.
  - Francisco: IA respondeu "Pedido confirmado! 🎉 Já estou passando
    para a cozinha" — mas não existe nenhum `delivery_order` nem
    `print_job` pra essa conversa. `add_to_cart`/`place_order` nunca
    foram chamados.
  - Ederson: IA montou um resumo com "3x Marmita M — Subtotal R$75",
    cliente estranhou ("Porque 3?"), IA "corrigiu" pra "1x Marmita M"
    mas manteve Subtotal R$75 e Total R$87 idênticos — e o carrinho
    real (`ai_cart`) estava vazio o tempo todo. Pego a tempo, antes do
    cliente confirmar chegar a virar pedido.
  - Causa raiz: mensagem de atendente humano (áudio/imagem) chegando no
    meio da conversa — em pelo menos um caso, claramente conversa
    interna da equipe sobre outro pedido, não destinada ao cliente —
    era transcrita e entrava no histórico que a IA lê marcada como
    `assistant`, exatamente igual à própria fala da IA
    ([context.ts](src/lib/ai/context.ts)). A IA lia a frase do humano
    ("vou tirar aqui o teu pedido") como se ela mesma já tivesse dito
    isso, achava que o pedido já estava anotado, e parava de chamar as
    ferramentas de verdade.
  - Corrigido: mensagem de atendente humano agora entra no histórico
    marcada explicitamente como não sendo a própria IA
    (`formatHumanAgentMessage`), mesmo padrão já usado pra localização
    (`formatLocationMessage`).
  - **Não resolve a causa mais funda**: por que conversa interna da
    equipe está caindo dentro do chat do cliente continua em aberto —
    fica pra investigar depois (provável mesmo número de WhatsApp
    sendo usado tanto pro cliente quanto entre a equipe).

## [0.10.12] — 2026-08-15

### Corrigido

- **IA dobrou a quantidade de todos os itens do pedido do Bruno**
  (Churrascaria Concórdia) — 3 marmitas M viraram 6, 1 Coca 2L virou 2
  no resumo de confirmação. Não relacionado ao revert do cache/modelo
  acima — aconteceu depois, já no GPT-5.4. Reconstruído pela conversa:
  a IA anotou 3 marmitas e 1 Coca corretamente, depois o cliente mandou
  várias mensagens seguidas (endereço, localização, CNPJ, pedido de
  nota fiscal, forma de pagamento) antes do resumo final — e em algum
  ponto disso `add_to_cart` foi chamado de novo pros mesmos itens,
  somando a quantidade (comportamento correto pra "bota mais uma", mas
  errado quando é só re-adicionar o que já tinha).
  - Prompt reforçado: instrução explícita pra checar o carrinho já
    mostrado em "Order so far" antes de montar o resumo do pedido, e
    nunca reconstruir o carrinho chamando `add_to_cart` de novo, não
    importa quantas mensagens chegaram desde a última vez que o item
    foi anotado.
  - Log de diagnóstico adicionado no merge de `add_to_cart` (esse
    exato caminho de código já causou 3 incidentes ao vivo antes
    desse, mas nunca tinha log nenhum — não deu pra confirmar 100% o
    mecanismo desta vez por falta de rastro).
  - **Sem garantia de que isso elimina o problema por completo** —
    é reforço de prompt, não uma trava de código; a próxima ocorrência
    (se houver) já vai ficar registrada no log pra confirmar o
    mecanismo com certeza.

## [0.10.11] — 2026-08-15

### Revertido

- **Cache de prompt (0.10.9) revertido** — reportado pelo dono da
  conta: depois de aplicado, a IA começou a alucinar. Revertida a
  reordenação do `buildSystemPrompt` e o `cache_control` do Anthropic,
  voltando ao comportamento de antes de 0.10.9. Nota honesta: no mesmo
  período o administrador da Concórdia também trocou o modelo de
  `openai/gpt-5.4` pra `meta-llama/llama-3.3-70b-instruct` (sugestão
  de custo dada em 0.10.9) — revertido de volta pro GPT-5.4 também,
  a pedido. As duas mudanças aconteceram juntas, então não dá pra
  cravar qual das duas foi a causa real da alucinação; revertidas as
  duas por precaução.

## [0.10.10] — 2026-08-14

### Corrigido

- **IA duplicava pedido quando o cliente corrigia algo depois de já ter
  confirmado** — achado ao investigar a reclamação da Concórdia ("a IA
  estava errando nos cálculos finais"). Não era erro de aritmética: um
  cliente pediu 4 marmitas P (pedido de R$95 criado e impresso), corrigiu
  pra 2 marmitas 48 segundos depois, e a IA — sem nenhuma forma de saber
  que já existia um pedido nesta conversa, e sem nenhuma ferramenta pra
  cancelá-lo — criou um SEGUNDO pedido (R$55) em vez de corrigir o
  primeiro. A cozinha recebeu duas notinhas pra um pedido só.
  - Novo campo `lastPlacedOrderId`/`lastPlacedOrderTotal` no estado do
    pedido (`order-state.ts`), gravado por `place_order` toda vez que
    cria um pedido.
  - Resumo do estado do pedido (injetado no prompt a cada turno) agora
    avisa explicitamente quando já existe um pedido criado nesta
    conversa, e instrui a IA a cancelar antes de recriar.
  - Nova ferramenta `cancel_order` — cancela o último pedido criado
    nesta conversa (dispara os mesmos webhook/automação de quando um
    humano cancela manualmente pelo painel). Recusa cancelar
    automaticamente um pedido já saiu para entrega ou entregue —
    nesse caso avisa que precisa de um humano.
  - Conferido no banco: só houve essa uma ocorrência de duplicação
    real na conta (os outros pares de mesmo valor encontrados são
    pedidos repetidos em dias diferentes, não duplicação de sessão).

## [0.10.9] — 2026-08-12

### Adicionado

- **Cache de prompt** — investigando o custo de IA da Concórdia
  (US$1,95 num dia, pedido pelo dono da conta), descoberto que 98%+
  dos tokens gastos eram de entrada (contexto reenviado), não de
  saída (resposta gerada): 1,52M tokens de entrada contra 16 mil de
  saída em 24h, média de 7.390 tokens de entrada por chamada em 206
  chamadas. Isso é o prompt do sistema inteiro + as 7 ferramentas de
  delivery sendo reenviados do zero em toda chamada.
  - `buildSystemPrompt` reordenado: todo conteúdo fixo por conta
    (instruções, prompt customizado do negócio) agora vem antes do
    conteúdo que muda a cada turno (estado do pedido, trechos da base
    de conhecimento) — antes o estado do pedido ficava no meio,
    quebrando o prefixo estável sem necessidade. Beneficia qualquer
    provedor com cache automático de prefixo (OpenAI e, por tabela,
    contas na OpenRouter usando modelo da OpenAI) sem precisar de
    nenhuma configuração — é só reordenação de conteúdo.
  - Pro provedor Anthropic (Claude), que exige marcação explícita:
    `cache_control` adicionado no prompt do sistema (na fronteira
    entre o trecho fixo e o dinâmico) e nas definições de ferramentas
    — cacheia tanto o prompt quanto o esquema das 7 ferramentas, que
    hoje são reenviadas inteiras em cada uma das várias chamadas de um
    único pedido (busca → detalhes → carrinho → frete → confirmar).
  - Cache de histórico de mensagens dentro de um mesmo loop de
    ferramentas (múltiplas chamadas pro mesmo pedido) fica de fora
    desta rodada — ganho menor, mais complexidade de implementar; pode
    ser revisitado depois. **Revertido em 0.10.11 — ver acima.**

## [0.10.8] — 2026-08-12

### Corrigido

- **Notinha (física e do navegador) nunca avisava que um pedido era
  retirada** — perguntado pelo dono da conta depois do fix de
  entrega/retirada no prompt. Não existe coluna `is_pickup` em
  `delivery_orders` (nunca existiu); retirada sempre foi inferida por
  `delivery_address` vir vazio, e as duas notinhas simplesmente
  omitiam a linha de endereço nesse caso — sem avisar nada, parecia
  que o endereço tinha sido esquecido. Pior ainda na notinha física:
  o cabeçalho sempre dizia "*** DELIVERY ***", mesmo em retirada.
  Corrigido nos dois: cabeçalho muda pra "*** RETIRADA ***" na notinha
  física, e as duas mostram uma linha explícita "RETIRADA NO LOCAL —
  sem entrega" no lugar do endereço.

## [0.10.7] — 2026-08-12

### Corrigido

- **IA pedia o endereço de entrega antes de perguntar se era retirada**
  — descoberto ao vivo na Churrascaria Concórdia: depois de saber o
  nome do cliente, a IA já emendava direto pra pedir o endereço, sem
  perguntar "entrega ou retirada?" antes. Só corrigia se o cliente
  avisasse por conta própria ("vou retirar"), o que passava a
  impressão de que a IA "não entendeu". Prompt reforçado: agora
  pergunta entrega/retirada cedo, antes do endereço, e reconhece
  qualquer forma de dizer que vai buscar ("vou retirar", "vou buscar",
  "vou passar aí", "retiro aí", "pego aí", "no balcão"...) — não só a
  palavra "retirada" — parando de pedir endereço na hora que isso for
  identificado.

## [0.10.6] — 2026-08-12

### Corrigido

- **Forma de pagamento não aparecia na notinha impressa de verdade**
  (impressora térmica, via `zontalk-print-agent.exe`) — o fix de ontem
  só cobriu a página de reimpressão do navegador
  (`/delivery/pedidos/[id]/imprimir`); o endpoint que alimenta o
  agente de impressão local (`GET /api/v1/print-jobs`) nunca incluía
  `payment_method`/`payment_notes` no JSON do recibo. Corrigido aqui.

  > **Resolvido no mesmo dia**: fonte maior e endereço em negrito na
  > notinha física dependiam do template impresso pelo próprio
  > `zontalk-print-agent.exe` — executável Windows separado cujo
  > código-fonte nunca tinha sido versionado em lugar nenhum (nem o
  > dono da conta tinha). Reconstruído do zero em
  > `clients/wacrm/print-agent/` (projeto próprio, fora deste repo) a
  > partir de engenharia reversa do binário compilado + uma notinha
  > real fotografada — mesmo `config.json`, mesmo fluxo de pareamento,
  > lojas já configuradas não precisam refazer o setup. As duas
  > mudanças pendentes foram aplicadas lá (fonte maior via
  > double-height ESC/POS, endereço em negrito) e o `.exe` publicado já
  > está atualizado em `/downloads/zontalk-print-agent.exe`. Ver
  > `clients/wacrm/print-agent/README.md` e seu próprio git log.

## [0.10.5] — 2026-08-11

### Adicionado

- **Cardápio do dia** — novo campo por dia da semana (texto livre,
  "o que tem no buffet hoje") pra IA responder com precisão quando o
  cliente pergunta o que tem disponível. Puramente informativo: não
  afeta preço nem pedido — isso continua sendo resolvido pelas
  sobrescritas de preço por dia da semana, já existentes e corretas.
  Configurável na própria tela de Cardápio.
- **Forma de pagamento na notinha de impressão** — a IA já capturava a
  forma de pagamento escolhida pelo cliente, mas ela nunca era salva
  no pedido em si; agora aparece impressa na notinha da cozinha.
- **Cardápio como item próprio na barra lateral**, logo abaixo de
  Delivery — antes só dava pra chegar lá entrando em Pedidos primeiro.

### Corrigido

- **Notinha de impressão com letra pequena demais pra ler na cozinha**
  — fonte aumentada em todo o corpo, e o endereço de entrega agora
  aparece em negrito pra se destacar.

  > **Migrations required:** aplique
  > `supabase/migrations/073_delivery_payment_method.sql` e
  > `supabase/migrations/074_ai_daily_menu.sql`. Ambas idempotentes.

## [0.10.4] — 2026-08-11

### Corrigido

- **Busca de produto (`search_menu`) não achava itens com acento
  diferente do catálogo, ou frases de várias palavras** — causa real
  por trás do relato "a IA não consegue consultar a base de
  conhecimento". A busca comparava a frase inteira, sensível a acento
  (sem extensão `unaccent` no Postgres); "rodízio" nunca batia com
  "Rodizio de Carne" no catálogo, e buscas de várias palavras juntas
  quase nunca encontravam nada. Agora normaliza acento/maiúscula e
  casa por palavra individual.

## [0.10.3] — 2026-08-11

### Adicionado

- **A IA agora sabe que dia é hoje.** Toda resposta passa a receber
  "Today is `<dia da semana>`, `<data>`" no prompt, no fuso horário da
  própria conta. Antes, uma pergunta respondida direto da base de
  conhecimento (não via consulta ao cardápio) — por exemplo "quanto é
  o rodízio hoje?", com a base listando um preço por dia da semana —
  não tinha como a IA saber que dia era, e tinha que adivinhar.
  Consultas ao cardápio (que já calculam o preço do dia certo no
  servidor) nunca tiveram esse problema.

## [0.10.2] — 2026-08-11

### Corrigido

- **IA perguntava a quantidade de novo mesmo quando o cliente já tinha
  dito** (ex.: "faz uma p pra mim" → "uma" já é a quantidade, mas a IA
  pedia confirmação do mesmo jeito). Prompt reforçado: números por
  extenso ou artigo indicando quantidade (um, uma, dois, duas...)
  agora contam como resposta dada.
- **Casamento de bairro ainda falhava com erro de ortografia de
  verdade** (o fix de ontem só cobria acento/maiúscula/o rótulo
  "Bairro" na frente). Agora cai pra distância de edição quando não
  há match exato, com limite proporcional ao tamanho do nome — e
  recusa a adivinhar quando dois bairros cadastrados ficam igualmente
  parecidos com o que foi digitado.

## [0.10.1] — 2026-08-10

### Adicionado

- **OpenRouter como provedor de transcrição de áudio**, além de
  Groq/OpenAI — a OpenRouter lançou endpoint próprio de transcrição em
  22/07/2026, no mesmo formato da OpenAI. Quando a conta já usa
  OpenRouter como provedor principal do chat, a transcrição reaproveita
  automaticamente a mesma chave — não precisa cadastrar uma chave
  separada só pra isso.

  > **Migration required:** aplique
  > `supabase/migrations/072_transcription_openrouter.sql`.
  > Idempotente — só amplia o `CHECK` de
  > `ai_configs.transcription_provider` pra aceitar `'openrouter'`.

### Corrigido

- **Casamento de bairro falhava quando o cliente respondia com o
  rótulo junto** ("Bairro Santo Onofre" em vez de só "Santo Onofre") —
  confirmado ao vivo num pedido real que acabou cancelado por causa
  disso, mesmo com o bairro certinho já cadastrado. A comparação só
  tirava acento/maiúscula, nunca a palavra "Bairro" na frente.

## [0.10.0] — 2026-08-09

Painel `/admin` deixa de ser só uma tabela de contas e vira um painel
de controle completo da plataforma, em 4 abas: **Dashboard**,
**Empresas**, **Planos** e **Financeiro**.

### Adicionado

- **Aba Dashboard**: números da plataforma inteira de uma vez —
  contas (total/ativas/suspensas, separando suspensão manual de
  suspensão por atraso), usuários e quantos estão online agora,
  conexões WhatsApp, conversas por status, contatos, mensagens
  enviadas/recebidas, faturamento pago/em aberto e a versão do
  sistema. Abaixo, um painel de saúde do servidor (CPU, memória,
  disco, status da instância compartilhada do wuzapi) e um botão de
  **reiniciar o backend** (com confirmação) pra não depender de SSH
  pra um restart de rotina.
- **Aba Financeiro**: toda fatura de todo cliente da plataforma, com
  filtro por data/status/empresa/busca/valor, 8 cards de resumo
  (faturamento total, recebido, em aberto, vencido, total de faturas,
  pagas, pendentes, ticket médio) e ações de marcar como paga,
  cancelar e copiar link de pagamento.
- **Aba Planos**: o CRUD de planos de assinatura (preço, ciclo,
  limite de usuários, módulos incluídos, público/privado,
  ativo/inativo) — já existia como página separada de uma iteração
  anterior, agora integrado como aba do mesmo painel.
- **Aba Empresas**: filtro por status/plano/conexão WhatsApp, coluna
  de receita vitalícia por conta, e duas ações direto na linha —
  trocar o plano e suspender/reativar — sem precisar abrir cada
  conta. A tela de detalhe de cada conta continua existindo pra
  uso de IA, histórico de faturas e módulos.

### Corrigido

- **Clique nas abas do `/admin` não respondia — sempre voltava pra
  Planos.** O valor da aba ativa era relido da URL a cada render e
  passado como controlado pro componente de Tabs; o clique disparava
  a navegação, mas o componente via o valor antigo de novo antes da
  URL terminar de atualizar e voltava pra aba anterior. A aba agora é
  estado local (a URL só serve de ponto de partida ao entrar na
  página), então o clique responde na hora.

## [0.9.1] — 2026-08-09

Continuação direta da rodada de confiabilidade do delivery via IA
(0.9.0) — um bug real de configuração da LocationIQ, uma conta de taxa
por km que superfaturava todo pedido, um conflito entre o prompt
próprio da conta e a regra anti-alucinação de valores, e uma forma de
nunca mais travar um pedido só porque o provedor de rotas engasgou.
Fecha também com um pedido novo: chave Pix própria, enviada
automaticamente na confirmação do pedido.

> **Migration required:** aplique
> `supabase/migrations/071_payment_pix_key.sql`. Idempotente —
> relaxa `mp_access_token`/`mp_webhook_secret` pra aceitar nulo e
> adiciona `payment_configs.pix_key`.

### Corrigido

- **Método "por bairro" estava com o casamento de bairro quebrado
  silenciosamente desde a troca pra LocationIQ (07/08).** Nenhuma das
  três chamadas de geocodificação pedia `addressdetails=1` — sem esse
  parâmetro a resposta da LocationIQ não vem com o bloco `address`
  nenhum, então o bairro devolvido era sempre `null`, não importa o
  que a API realmente soubesse sobre o lugar. Só não tinha aparecido
  antes porque na maioria das vezes o modelo já passava o bairro
  explícito como argumento, contornando o bug sem querer. Confirmado
  ao vivo: um cliente respondeu só o nome do bairro (batendo exato com
  o cadastrado) duas vezes seguidas, e a IA disse as duas vezes que não
  reconheceu.
- **`base_price` do método "por km" estava sendo somado à taxa por
  distância em vez de servir como valor mínimo.** Confirmado com o
  dono da conta: `base_price` é o piso pra uma corrida bem curta
  (~1km ou menos), não um adicional em cima de toda entrega — a
  fórmula original (`base + distância × taxa`) superfaturava
  literalmente todo pedido por km, não só os curtos. Uma entrega de
  6,35km com mínimo R$6 e R$2,20/km saía R$19,96 em vez do correto
  R$13,97. Rótulo em Configurações renomeado de "Taxa base" pra "Taxa
  mínima" com uma explicação, pra não induzir a mesma configuração
  errada de novo.
- **Retentativas da LocationIQ alargadas** (300ms/900ms → 500ms/
  1.200ms/2.500ms, 2 → 3 tentativas) — confirmado ao vivo que o limite
  por segundo do plano grátis ainda estava sendo atingido com
  frequência incômoda mesmo com o limitador de concorrência já no ar;
  espaçar mais reduziu bastante a chance de cair numa rajada.
- **O prompt próprio da conta podia sobrepor a regra de "nunca invente
  um valor, sempre copie exato da ferramenta".** Um prompt customizado
  que pede um resumo de pedido num formato específico (com espaços
  "R$ __" pra preencher) é a instrução mais recente e específica que o
  modelo vê antes de responder — e passou a vencer a regra genérica
  anterior sobre nunca calcular valores. A regra agora é repetida
  logo depois do prompt da própria conta, cobrindo explicitamente o
  caso de template: preencha os espaços só com o que a ferramenta
  devolveu, nunca com um número inventado.

### Adicionado

- **Nunca mais trava um pedido por instabilidade do provedor de
  rotas.** Quando o cálculo de distância real falha mesmo depois de
  todas as tentativas (confirmado ao vivo: a mesma rota falhou 8 vezes
  num único dia, mesmo já com retry alargado), o sistema agora estima
  a distância em linha reta com uma margem de 35% (sempre arredondando
  pra cima, nunca deixa o cliente pagar menos por uma rota que na
  verdade é mais longa) em vez de simplesmente falhar. O pedido segue
  com uma taxa aproximada em vez de pedir pro cliente esperar — na
  esmagadora maioria das vezes o cálculo exato continua sendo usado
  normalmente.
- **Chave Pix própria da conta**, em Configurações → Pagamento,
  independente do Mercado Pago (não precisa configurar checkout online
  pra usar isso). Assim que a IA confirma um pedido pago via Pix, a
  chave é incluída automaticamente na mensagem de confirmação —
  substitui o método anterior de colar a chave direto no prompt da IA,
  que não tinha garantia nenhuma de ser realmente enviada.

### Alterado

- **Mensagem final da confirmação de pedido**: "Em breve confirmamos o
  seu pedido." → "Seu pedido foi enviado para a cozinha."
- O motivo de falha `distance_failed` foi removido — com o fallback de
  estimativa acima, o cálculo de distância não falha mais de verdade,
  só produz um valor aproximado.

## [0.9.0] — 2026-08-08

Uma rodada de confiabilidade no **fluxo de pedidos por delivery via
IA**, feita em cima de teste em produção ao vivo (clientes reais, bugs
reais, no mesmo dia). O agente de chat da IA ganha três capacidades
novas — pedido via localização compartilhada do WhatsApp, transcrição
de áudio, e horário de funcionamento próprio — mais uma correção
estrutural (estado persistente do pedido) para a causa raiz da maioria
dos bugs de pedido encontrados neste ciclo: o modelo **não tem memória
das próprias chamadas de ferramenta em turnos anteriores**, só do
transcript legível por humano, o que repetidamente causava linhas
duplicadas no carrinho, perguntas repetidas, e uma discrepância de
preço por cotação desatualizada.

> **Nota para outros devs:** `dev/alteracoes` (tags `v6`–`v9`) divergiu
> da `main` em 2026-08-05 e continuou sendo trabalhada
> independentemente — parte dela (transcrição de áudio, horário de
> funcionamento, o retry de geocode sem número da casa) foi trazida via
> cherry-pick/merge manual pra `main` dias depois, em cima de trabalho
> não relacionado feito no mesmo dia aqui, e é por isso que as
> migrations 066–070 não batem de forma limpa com a numeração de
> nenhuma branch isolada. Se for retomar a `dev/alteracoes`: compare
> (diff) com a `main` atual primeiro, não assuma que é um fast-forward
> limpo — o tratamento de localização do WhatsApp em particular foi
> reimplementado do zero na `main` (`OrderInfo.location` + uma checagem
> determinística `mostRecentSharedLocation` no banco) em vez de
> aproveitado como estava, porque foi construído em cima de uma
> estrutura `location` no `fee-engine.ts` mais nova que a própria
> versão da `dev/alteracoes`.

> **Migration required:** aplique, em ordem,
> `supabase/migrations/066_ai_reply_debounce.sql` até
> `070_ai_business_hours.sql` (066–070). As cinco são idempotentes
> (`ADD COLUMN IF NOT EXISTS`) — seguras pra rodar de novo.

> **Nova variável de ambiente (self-hosted, só módulo Delivery):**
> `LOCATIONIQ_API_KEY` — obrigatória a partir da troca de provedor
> abaixo. Pegue uma chave grátis em
> [locationiq.com](https://locationiq.com) (sem cartão, 5.000
> requisições/dia). `DISTANCE_PROVIDER=ors` volta pro provedor
> OpenRouteService anterior, se preferir manter seu `ORS_API_KEY`
> existente.

### Adicionado

- **Pedido via localização compartilhada do WhatsApp.** O cliente pode
  mandar um pin de GPS em vez de digitar o endereço —
  `calculate_delivery_fee` / `place_order` detectam isso
  automaticamente (uma checagem determinística contra a última
  mensagem do próprio cliente, sem depender do modelo perceber/
  interpretar nada) e usam as coordenadas exatas, pulando a
  geocodificação inteiramente. Quando o cliente só compartilha o pin e
  nunca digita um endereço, o pedido salva um link clicável do Google
  Maps em vez de deixar o endereço de entrega vazio.
- **Transcrição de áudio.** Mensagens de voz recebidas pelo WhatsApp
  são transcritas (compatível com Whisper, Groq ou OpenAI, chave
  própria do cliente — mesmo padrão da chave de embeddings) pra que
  tanto a IA quanto os atendentes humanos consigam ler o que foi dito.
  Opcional e independente do provedor do chat; um áudio não transcrito
  continua sendo salvo/tocando exatamente como antes.
- **Horário de funcionamento próprio da IA.** Uma agenda separada e
  opcional em relação à `delivery_business_hours` — uma conta pode
  rodar o bot de IA num número de WhatsApp usado pra mais coisas além
  de pedidos, então "quando aceitamos pedidos" e "quando o bot responde
  automaticamente" agora são configuráveis de forma independente em
  **Configurações → IA**. Fora do horário o bot fica completamente em
  silêncio (nenhuma mensagem automática).
- **Estado persistente do pedido.** `conversations.ai_order_info`
  (junto do já existente `ai_cart`) acompanha nome do cliente, retirada/
  entrega, endereço, bairro, forma de pagamento, e a última cotação de
  taxa entre turnos, injetado no prompt do sistema a cada turno como
  verdade absoluta. Nova ferramenta `update_order_info` deixa o modelo
  registrar um dado assim que ele é informado, em vez de precisar
  re-derivar isso rolando a conversa pra trás.
- **Teto de iterações de ferramenta por conta.**
  `ai_configs.max_tool_iterations` (Configurações → IA) substitui uma
  constante fixa no código — um negócio que fecha pedidos inteiros via
  chat pode precisar de mais idas-e-voltas de ferramenta por turno do
  que qualquer padrão global fixo suportava.

### Alterado

- **Provedor padrão de distância/geocodificação trocado para
  LocationIQ** (antes OpenRouteService) — 5.000 requisições/dia numa
  chave grátis, divididas entre geocode/reverse/directions em vez de
  uma cota única compartilhada (2.500/dia), que foi repetidamente
  esgotada por tráfego real e custou pelo menos dois pedidos reais de
  clientes. O ORS continua no código como um rollback documentado de
  uma única variável de ambiente (`DISTANCE_PROVIDER=ors`).
- **Resultados de geocode/directions agora são cacheados (TTL de 15
  min) e deduplicados** para requisições concorrentes idênticas, e as
  requisições de saída deste processo pra LocationIQ agora têm um
  limite de 2 simultâneas — dois clientes testando com o mesmo
  endereço ao mesmo tempo não derrubam mais o rate limit do provedor
  um contra o outro.
- **O endereço em texto livre do cliente agora é enriquecido
  automaticamente com a cidade/estado cadastrados da conta** antes de
  geocodificar, quando o texto do cliente ainda não menciona nenhum —
  ninguém localmente prefixa a própria rua com a cidade, e todo cliente
  de toda conta tem esse mesmo ponto cego.
- **Falhas de geocode agora tentam de novo uma vez com o número da
  casa removido** antes de desistir (a cobertura exata de número da
  casa é fina em algumas ruas, o que travava um endereço genuinamente
  correto e completo), e são logadas no servidor com o erro real do
  provedor — antes era silencioso, só diagnosticável reproduzindo o
  endereço manualmente depois.
- **`distance_failed` separado de `geocode_failed`** como motivo de
  falha próprio — um endereço que geocodificou certinho mas depois
  falhou na etapa de rota/distância precisa de uma orientação diferente
  pro cliente ("aguarde e tente de novo") do que um que não foi
  encontrado ("tente compartilhar sua localização") — misturar os dois
  fazia o bot dizer pra um cliente cujo endereço já tinha sido
  encontrado corretamente que compartilhasse a localização, o que passa
  pela mesma chamada de distância e não ajudaria em nada.
- **O recálculo final obrigatório de taxa do `place_order` agora reusa
  o endereço/coordenadas exatos que sua própria cotação confirmada
  usou**, em vez de re-derivar do texto livre — corrige um caso real em
  que um cliente foi cotado R$9 (a partir de um pin de localização
  exato) e cobrado R$11,82 (a reconferência regeocodificou o texto do
  endereço pra um ponto menos preciso).
- **Os toggles de ligado/desligado e resposta automática em
  Configurações → IA agora salvam imediatamente** ao clicar, em vez de
  só no botão "Salvar" do formulário — confirmado ao vivo que o bot
  continuava respondendo por ~17 minutos depois de um admin desligar
  visualmente.

### Corrigido

- **`add_to_cart` não cria mais linhas duplicadas no carrinho** para o
  mesmo item em chamadas de ferramenta separadas na mesma conversa — o
  modelo não tem memória das próprias chamadas anteriores, então uma
  chamada de "adicionar" simples seguida de uma nota de personalização,
  ou qualquer repetição exata, agora funde na linha já existente em vez
  de duplicá-la (confirmado ao vivo: um item de R$20 aparecendo como
  R$40).
- **Mensagens rápidas e consecutivas do cliente não disparam mais
  respostas duplicadas da IA** que silenciosamente dobravam o consumo
  do limite de respostas por conversa — um debounce de 2 segundos deixa
  uma rajada assentar em uma única resposta.
- **`conversations.ai_cart` não corrompe mais para uma string JSON no
  handoff**, o que antes travava permanentemente o `cart.reduce` para
  qualquer conversa retomada depois de um atendente assumir.
- **O subtotal/total do resumo do pedido agora é sempre copiado
  caractere-por-caractere de uma resposta de ferramenta**, nunca
  calculado pelo próprio modelo — confirmado ao vivo: um único item de
  R$25 foi alucinado como um subtotal de R$100.
- **Um pedido de retirada (`is_pickup: true`) não exige mais endereço
  de entrega nem dispara o cálculo de taxa** — antes, qualquer método de
  taxa baseado em distância exigia um endereço que o cliente já tinha
  dito que não precisava.
- Esgotamento do loop de ferramentas e uma resposta vazia do provedor
  no meio do loop agora são logados e tentados de novo uma vez, em vez
  de deixar um pedido silenciosamente travado no meio do fluxo.

## [0.8.1] — 2026-07-10

Corrige conversas recebidas se fragmentando em múltiplas threads para
o mesmo número.

> **Migration required:** aplique `supabase/migrations/036_conversation_contact_dedup.sql`
> (funde qualquer conversa duplicada existente na thread mais antiga —
> nenhuma mensagem é perdida — depois adiciona um índice
> `UNIQUE (account_id, contact_id)` pra que um contato só possa ter uma
> conversa).

### Corrigido

- **Chats duplicados para um mesmo contato.** Uma mensagem recebida
  podia criar uma segunda conversa pra um contato numa condição de
  corrida (Meta reenviando uma entrega, ou um lote gerando execuções
  concorrentes). Uma vez que existiam duas, a busca com `.single()`
  dava erro em toda mensagem seguinte e o webhook criava mais uma
  conversa a cada vez, virando uma bola de neve de chats duplicados. O
  find-or-create agora resolve pra thread já existente mais antiga e um
  índice único no banco torna a regra de uma-conversa-por-contato
  definitiva. O mesmo reforço foi aplicado ao resolvedor de conversa da
  API pública. (Issue #363)

## [0.8.0] — 2026-07-08

Refinamentos no bot de resposta automática da IA: agora ele é
**visível e controlável pela caixa de entrada**, o **handoff realmente
entrega o atendimento**, e o **gasto de tokens é registrado**.

> **Migration required:** aplique `supabase/migrations/033_ai_reply_polish.sql`
> (adiciona `messages.ai_generated`, `ai_configs.handoff_agent_id`,
> `conversations.ai_handoff_summary`, e a tabela `ai_usage_log`).

### Adicionado

- **Selo "IA" na caixa de entrada.** Respostas enviadas pelo bot ganham
  um pequeno selo ✨ IA, pra que os atendentes distingam uma resposta
  automática de uma própria ou de um Flow com um olhar. (Novo flag
  `messages.ai_generated`; só o bot de resposta automática o define.)
- **Assumir / Retomar direto na conversa.** Um banner nas conversas
  tocadas pela IA deixa um atendente **Assumir** (pausa o bot naquela
  thread e a atribui a ele) ou **Retomar IA** (devolve a thread e
  limpa a pausa). Sustentado por `POST /api/ai/autoreply/[id]`.
- **Handoff de verdade.** Quando o bot desiste (não consegue ajudar, ou
  bate no limite de respostas) agora ele (1) roteia a conversa pra um
  **destino de handoff** configurável — um atendente específico, ou a
  fila sem atribuição — e (2) deixa uma **nota interna** curta
  resumindo a troca pra quem for pegar o atendimento. Atribuir dispara
  a notificação de atribuição já existente. Escolha o destino em
  **Agentes de IA → Configuração → Repassar para**.
- **Registro de uso de tokens + painel.** Todo rascunho e resposta
  automática registra suas contagens de tokens do provedor na nova
  tabela `ai_usage_log` (legível por admin). Uma nova aba **Agentes de
  IA → Uso** (só admin) mostra em gráfico o gasto diário de tokens na
  sua chave própria, com detalhamento por modo e por modelo, sustentado
  por `GET /api/ai/usage`. Só contagens — nenhum conteúdo de mensagem é
  guardado ou exibido.

### Alterado

- A resposta automática agora tem um **limite de taxa por conta**
  (30/min) além do teto já existente por conversa, pra que uma rajada
  de mensagens recebidas não passe do limite da sua chave de provedor.
  Acima do limite, as mensagens simplesmente esperam na caixa de
  entrada por um humano em vez de serem respondidas automaticamente.

## [0.7.0] — 2026-07-02

Promove o assistente de IA a uma seção própria de primeira classe
**Agentes de IA** na barra lateral — não fica mais escondido dentro de
Configurações.

### Adicionado

- **Agentes de IA (barra lateral).** Uma área dedicada `/agents` com
  duas abas:
  - **Playground** — um chat de teste pra conversar com seu agente e
    ver as respostas embasadas e multi-turno dele (e onde ele
    repassaria pra um humano) *antes* de responder um cliente de
    verdade. Roda exatamente o mesmo caminho do bot de resposta
    automática (busca na base de conhecimento + seu provedor), e
    funciona mesmo antes de você ligar a chave mestra, pra você testar
    e só depois ativar. Sustentado por `POST /api/ai/playground`.
  - **Configuração** — o provedor/chave, contexto do negócio, base de
    conhecimento, e os controles de resposta automática (movidos pra
    cá de Configurações → Assistente de IA).

### Alterado

- A configuração da IA saiu de **Configurações → Assistente de IA**
  pra nova seção **Agentes de IA**. Sem mudança de dado — mesma
  configuração da conta, novo endereço. Sem migration necessária.

## [0.6.0] — 2026-07-02

Adiciona uma **base de conhecimento de IA** pra que o assistente
(0.5.0) responda a partir do seu próprio conteúdo em vez de repassar
pra um humano. Cole FAQs, políticas, ou detalhes de produto em
**Configurações → Assistente de IA → Base de conhecimento**; os
trechos relevantes são recuperados em todo rascunho e resposta
automática.

### Adicionado

- **Base de conhecimento com busca híbrida.** Busca lexical em
  Postgres full-text funciona pra toda conta sem credencial extra.
  **Busca semântica** opcional (pgvector, OpenAI
  `text-embedding-3-small`) liga quando você adiciona uma **chave de
  embeddings** — semântica como principal, complementada com lexical
  pra completar o conjunto de resultados. Contas só-Anthropic
  (Anthropic não tem API de embeddings) seguem no caminho lexical sem
  configuração extra nenhuma.
- **Gerenciador de base de conhecimento** em Configurações —
  adicionar/editar/excluir documentos e uma ação **Reindexar** pra
  preencher embeddings depois de adicionar uma chave. Tanto rascunhos
  quanto o bot de resposta automática são embasados nos trechos
  recuperados, e o prompt ainda instrui o modelo a repassar pra um
  humano (resposta automática) ou dizer que vai retornar (rascunho)
  quando a base de conhecimento não cobrir a pergunta.
  **Migration required:** aplique `supabase/migrations/030_ai_knowledge.sql`
  (habilita `pgvector`; adiciona `ai_knowledge_documents` +
  `ai_knowledge_chunks` e uma coluna `embeddings_api_key` em
  `ai_configs`).

## [0.5.0] — 2026-07-02

Adiciona o **assistente de resposta por IA** — chave própria do
cliente. Cada conta cola sua própria chave OpenAI ou Anthropic em
**Configurações → Assistente de IA**; o wacrm chama o provedor
diretamente com essa chave, então não há taxa de IA por assento e os
dados da sua conversa nunca saem da sua própria infraestrutura pra um
serviço rodado pelo wacrm. A chave é guardada criptografada em
AES-256-GCM em repouso (igual aos tokens do WhatsApp) e nunca
devolvida ao cliente depois de salva.

### Adicionado

- **Respostas rascunhadas por IA na caixa de entrada.** Um botão ✨ no
  compositor (agente+) lê a conversa recente e coloca uma resposta
  sugerida na caixa pro atendente editar e enviar. Só leitura no
  servidor — `POST /api/ai/draft` nunca envia nem guarda nada. Respeita
  o contexto de negócio/persona do prompt de configurações.
- **Bot de resposta automática por IA.** Quando ligado, mensagens
  recebidas que nenhum Flow determinístico consumiu e que não têm
  atendente atribuído recebem uma resposta automática por LLM.
  Limitado por um teto por conversa
  (`auto_reply_max_per_conversation`, padrão 3) e um handoff limpo pra
  humano: quando o modelo não consegue ajudar com confiança — ou o
  cliente pede uma pessoa — ele fica em silêncio e deixa a mensagem
  pra um humano, e não responde automaticamente naquela thread de novo
  até ser reativado. Flows sempre têm prioridade sobre o bot.
- **Configurações → Assistente de IA** (admin+ pra editar): escolha
  provedor + modelo, cole sua chave, adicione contexto/tom do negócio,
  ligue o assistente e a resposta automática, defina o teto por
  conversa, e **Testar chave** contra o provedor antes de salvar.
- Provedores: OpenAI (Chat Completions) e Anthropic (Messages) atrás de
  uma única interface; o modelo é um campo de texto livre com padrões
  sensatos, pra você apontar pra qualquer modelo atual que sua chave
  acesse.
  **Migration required:** aplique
  `supabase/migrations/029_ai_reply.sql` (adiciona `ai_configs` +
  colunas de resposta automática por conversa em `conversations`).

## [0.4.0] — 2026-07-01

Completa a API pública (#245): **webhooks de eventos de saída** pra que
automações consigam *reagir* a atividade em vez de fazer polling.

### Adicionado

- **Webhooks de eventos de saída (`/api/v1/webhooks`).** Registre um
  endpoint HTTPS (escopo `webhooks:manage`) pra receber um POST quando
  um evento acontece na sua conta — `message.received`,
  `message.status_updated`, ou `conversation.created`. Gerencie
  endpoints com `GET/POST /api/v1/webhooks` e
  `GET/PATCH/DELETE /api/v1/webhooks/{id}`. Cada entrega é assinada com
  um `X-Wacrm-Signature` (HMAC-SHA256 sobre `timestamp.body`) pra que
  quem recebe consiga verificar autenticidade e rejeitar replays; o
  segredo de assinatura é devolvido uma única vez na criação e guardado
  criptografado. A entrega é best-effort — um endpoint que falha
  repetidamente é desativado automaticamente depois de um limite de
  falhas consecutivas. Veja `docs/public-api.md`.
  **Migration required:** aplique
  `supabase/migrations/028_webhook_endpoints.sql`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

## [0.3.0] — 2026-07-01

Contas multiusuário no ar. Toda instalação wacrm é multi-tenant no lado
do banco: o cadastro de um único usuário cria uma "conta" nova, e toda
linha é vinculada àquela conta em vez de diretamente ao usuário. Este
lançamento também abre a superfície visível de **Membros** — convidar
colegas por link, gerenciar seus papéis, transferir titularidade —
pra todos os usuários. O gate de beta `'account_sharing'` que a
escondia durante o desenvolvimento é removido (espelha o soft-GA dos
Flows na 0.2.0). Instâncias self-hosted existentes continuam
funcionando: todo usuário existente é migrado como único dono da
própria conta e vê os mesmos dados de sempre, e um dono solo que nunca
convidou ninguém vê o mesmo app de usuário único de sempre.

### Adicionado

- **API REST pública (`/api/v1`) — base.** Um sistema de **chave de
  API** com escopo e revogável pra você operar o wacrm a partir dos
  seus próprios scripts e automações. Crie chaves em **Configurações →
  Chaves de API** (admin+), conceda só os escopos que cada integração
  precisa, e autentique com `Authorization: Bearer <key>`. Chaves são
  vinculadas à conta e guardadas com hash (texto puro exibido uma
  única vez). Este lançamento traz a camada de autenticação, escopos,
  limite de taxa por chave, a UI de gerenciamento, e uma sonda
  `GET /api/v1/me` pra verificar uma chave. Veja
  `docs/public-api.md`. **Migration required:** aplique
  `supabase/migrations/026_api_keys.sql`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))
- **API REST pública — endpoints de dados.** Construída em cima da
  autenticação por chave acima, pra automações externas lerem e
  operarem o CRM:
  - `POST /api/v1/messages` — envia mensagem de texto / template /
    mídia pra um número de telefone; encontra-ou-cria o contato +
    conversa (`messages:send`).
  - `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` —
    lista (busca + filtro por tag), cria (encontra-ou-cria por
    telefone), lê, e atualiza contatos, incluindo tags
    (`contacts:read` / `contacts:write`).
  - `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`, e
    `GET /api/v1/conversations/{id}/messages` — navega conversas e seu
    histórico de mensagens com status de entrega
    (`conversations:read` / `messages:read`).
  - `POST /api/v1/broadcasts` + `GET /api/v1/broadcasts/{id}` —
    dispara uma transmissão de template pra uma lista de destinatários
    e acompanha o progresso (`broadcasts:send`).
  Todos os endpoints de listagem compartilham um único contrato de
  paginação por cursor (`{ data, meta: { next_cursor } }`). Sem
  migration necessária — os escopos já existiam e as tabelas não
  mudaram. Webhooks de eventos de saída (reagir a mensagens recebidas)
  são o item restante do roadmap. Veja `docs/public-api.md`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

### Alterado

- **Tenancy migra de por-usuário pra por-conta.** RLS em toda tabela de
  domínio (contatos, conversas, mensagens, transmissões, automações,
  flows, pipelines, templates, tags, …) agora checa membresia de conta
  via um novo helper SECURITY DEFINER `is_account_member(account_id,
  min_role)` em vez de `auth.uid() = user_id`. As colunas `user_id`
  continuam em toda linha pra atribuição/auditoria mas não impõem mais
  isolamento.
- **Configuração de WhatsApp passa a ser uma-por-conta, não
  uma-por-usuário.** A constraint `whatsapp_config.UNIQUE(user_id)` é
  substituída por `UNIQUE(account_id)`.
- **A chave de idempotência de `flow_runs` passa pra
  `(account_id, contact_id)`** pra que duas contas compartilhando um
  número de telefone de contato rodem cada uma seus próprios flows de
  forma independente.
- **O trigger de cadastro (`handle_new_user`) agora também cria uma
  conta pessoal** e vincula o novo perfil a ela como `owner`.

### Alterado

- **O armazenamento de mídia de Flow agora é vinculado à conta.** A
  migration 016 caminhava arquivos enviados sob `auth.uid()/...`, o
  que órfãos a mídia de flow quando um colega saía de uma conta
  compartilhada. Novos envios vão pra `account-<account_id>/...` e
  qualquer membro da conta com o papel certo consegue editá-los.
  Caminhos antigos continuam graváveis pelo autor original, por
  compatibilidade.
- **A busca de contato no webhook agora pré-filtra em SQL.**
  Antes puxava todo contato de uma conta só pra filtrar em JS até uma
  linha por telefone — tranquilo quando conta = um usuário, doloroso
  quando conta = time. Pré-filtra por sufixo de telefone no lado do
  banco; reaplica `phonesMatch` no conjunto de candidatos (tipicamente
  0-2 linhas).

### Migration required

- `supabase/migrations/020_account_sharing_followups.sql` — índices
  parciais compostos em `automations(account_id, trigger_type) WHERE
  is_active` e `flows(account_id) WHERE status='active'` pro caminho
  quente de despacho do engine; RLS de armazenamento `flow-media`
  atualizada pra permitir gravação por membro da conta na nova
  convenção de caminho. Idempotente.

- **UI com controle de acesso por papel em todo o app.** O botão de
  enviar + textarea do compositor da caixa de entrada, os botões "Nova
  transmissão / automação / flow", os botões "Adicionar
  pipeline / negócio", e os botões "Adicionar / Importar contato"
  agora ficam desabilitados-com-tooltip pra viewers (e pra agentes em
  ações de classe configurações). Escolha: mostrar-mas-desabilitar em
  vez de esconder, pra que a UI nunca pareça silenciosamente quebrada
  pra um colega olhando um recurso que ainda não tem permissão.
- **A barra lateral mostra a conta ativa** acima das informações do
  usuário sempre que o nome da conta difere do seu próprio — ou seja,
  uma vez que você renomeou a conta ou entrou numa compartilhada. Uma
  conta solo padrão leva seu próprio nome, então a faixa fica
  escondida pra evitar duplicar seu nome no rodapé.
- **Membros está aberto pra todos os usuários.** O flag de beta
  `account_sharing` que escondia a aba Configurações → Membros e a
  faixa de conta na barra lateral durante o desenvolvimento acabou; a
  superfície multiusuário agora é parte do app padrão. (Mesmo
  movimento de soft-GA dos Flows na 0.2.0.)

### Corrigido

- **Mensagens de WhatsApp recebidas agora chegam na caixa de entrada
  compartilhada.** Os engines de webhook + automações + flows
  roteavam mensagens recebidas por `user_id`, o que depois da
  migration 017 só batia com as automações/flows do dono da
  configuração de WhatsApp — as regras dos colegas nunca disparavam.
  O PR 8 da série multiusuário troca toda busca pra `account_id`, pra
  que qualquer membro da conta veja a mensagem recebida e qualquer
  automação ou flow de um colega consiga reagir a ela. Também corrige
  violações incipientes de NOT NULL em `automation_logs`,
  `automation_pending_executions`, `flow_runs`, e `deals` — essas
  tabelas ganharam `account_id NOT NULL` na 017 mas os engines ainda
  não tinham sido atualizados pra preenchê-la.

### Adicionado

- **Números de telefone duplicados agora são prevenidos entre
  contatos.** Um número de telefone não pode mais virar mais de um
  contato na mesma conta. Adicionar um contato cujo número já existe é
  bloqueado com um link pro registro existente (e um aviso mais leve
  pra quase-coincidências que compartilham os últimos 8 dígitos);
  importação CSV deduplica dentro do arquivo e contra contatos
  existentes, reportando "X importados, Y duplicados ignorados". A
  regra é aplicada por um índice único no banco sobre o número
  normalizado, então o webhook do WhatsApp, o formulário, a
  importação, e qualquer caminho futuro concordam. Duplicados
  existentes são fundidos no contato mais antigo na atualização (suas
  conversas, negócios, notas, e tags são re-apontados, nada é
  perdido). Fecha #212.
- **Moeda padrão de negócio configurável.** Cada conta agora pode
  escolher sua moeda padrão em **Configurações → Negócios** (admin+);
  o app antes fixava USD em tudo. Novos negócios usam ela por padrão,
  e os totais por estágio do pipeline, o card "Valor de negócios
  abertos" do dashboard, o donut de valor do pipeline, e os negócios
  criados por automação todos a usam. Negócios existentes mantêm a
  moeda com que foram salvos — totais são exibidos na moeda padrão da
  conta sem conversão de câmbio (uma moeda por conta). Guia completo:
  [Moeda padrão](https://wacrm.tech/docs/settings#deals).
- **Aba Membros em Configurações.** A superfície visível pro usuário
  das APIs multiusuário abaixo, disponível pra todos (sem flag de
  beta). Em Configurações → **Membros** um admin ou dono pode: ver
  quem está na conta com papel e data de entrada, convidar colegas
  gerando um link de compartilhamento de uso único (escolhendo papel +
  validade opcional), revogar convites pendentes, mudar o papel de um
  membro, remover um membro, e — como dono — transferir a
  titularidade. Quem recebe aceita por uma página pública
  `/join/[token]`. Guia completo:
  [Docs de Membros](https://wacrm.tech/docs/members).
- **API de gerenciamento de conta e membros** — endpoints no servidor
  que sustentam a aba Membros. Todas as rotas são controladas por
  papel e devolvem dados com escopo RLS do Supabase.
  - `GET /api/account` — conta + papel de quem chama. Qualquer membro.
  - `PATCH /api/account` — renomeia a conta. Admin+.
  - `GET /api/account/members` — lista membros. E-mail visível só pra
    admin+; agentes/viewers veem nome + avatar + papel + data de
    entrada.
  - `PATCH /api/account/members/[userId]` — muda o papel de um
    membro. Admin+. Promoção/rebaixamento de dono passa pelo endpoint
    de transferência.
  - `DELETE /api/account/members/[userId]` — remove um membro. Admin+.
    O usuário removido mantém seu login e é movido pra uma conta
    pessoal recém-criada (espelha o fluxo de cadastro).
  - `POST /api/account/transfer-ownership` — só dono. Troca atômica
    com o membro nomeado.
- **API de convites + fluxo de resgate** — o caminho de convite sem
  e-mail, só por link, que alimenta o botão "Convidar membro" da aba
  Membros e a página de aceite `/join/[token]`.
  - `GET /api/account/invitations` — lista pendentes (admin+).
  - `POST /api/account/invitations` — cria um convite, devolve o token
    em texto puro + URL de compartilhamento **exatamente uma vez**
    (guardamos só o hash SHA-256 na linha). Corpo
    `{ role, expiresInDays?, label? }`. Admin+.
  - `DELETE /api/account/invitations/[id]` — revoga (admin+).
  - `GET /api/invitations/[token]/peek` — público, com limite de taxa
    por IP. Devolve `{ ok, account_name, role, expires_at }` ou
    `{ ok: false, reason }` pra que a página de entrada renderize
    "Você está sendo convidado pra <Conta> como <Papel>".
  - `POST /api/invitations/[token]/redeem` — autenticado. Move
    atomicamente o perfil de quem chama pra conta de quem convidou e
    limpa a conta pessoal órfã. Recusa com 409 se a conta atual de
    quem chama já contém dado de domínio (sem perda silenciosa de
    dado).

### Migration required

Aplique no seu projeto Supabase antes de fazer deploy desta versão:

- `supabase/migrations/017_account_sharing.sql` — introduz as tabelas
  `accounts` e `account_invitations` mais um tipo
  `account_role_enum`; adiciona `account_id` em toda tabela vinculada
  a usuário e a preenche retroativamente; reescreve toda policy de
  RLS; substitui o trigger de novo usuário. Idempotente. **Sem perda
  de dado** — todo usuário existente é mapeado pra uma conta
  recém-criada com papel `owner` e toda linha existente dele é
  vinculada àquela conta.
- `supabase/migrations/018_account_member_rpcs.sql` — adiciona três
  RPCs `SECURITY DEFINER` (`set_member_role`, `remove_account_member`,
  `transfer_account_ownership`) que sustentam a API de gerenciamento
  de membros. Elas mesmas checam o papel de quem chama e levantam
  SQLSTATE `42501` / `22023` pra entrada proibida/inválida, pra que a
  camada de API mapeie limpo pra 403 / 400. Idempotente.
- `supabase/migrations/019_invitation_rpcs.sql` — adiciona duas RPCs
  `SECURITY DEFINER`: `peek_invitation` (leitura anônima por hash de
  token, devolve um envelope JSON de formato fixo) e
  `redeem_invitation` (movimento atômico autenticado + limpeza de
  órfão, com checagem de segurança de dado de domínio). Ambas
  ignoram o RLS que de outra forma bloquearia suas leituras/escritas.
  Idempotente.
- `supabase/migrations/021_account_default_currency.sql` — adiciona
  `accounts.default_currency` (`TEXT NOT NULL DEFAULT 'USD'`, com um
  `CHECK` de código de 3 letras) sustentando a moeda padrão
  configurável. Idempotente; contas existentes recebem `USD`
  retroativamente. **Aplique antes de fazer deploy** — o app agora lê
  essa coluna ao carregar a conta, então um banco sem a migration
  quebra o carregamento de conta.
- `supabase/migrations/022_contact_phone_dedup.sql` — adiciona a
  coluna gerada `contacts.phone_normalized`, **funde contatos
  duplicados existentes no mais antigo** (re-apontando conversas,
  negócios, notas, tags, valores customizados, e destinatários de
  transmissão — sem perda de dado), depois adiciona um índice
  `UNIQUE (account_id, phone_normalized)`. Idempotente. **Aplique
  antes de fazer deploy** — a importação CSV lê `phone_normalized`, e
  o índice é o que garante a deduplicação em todo caminho de escrita.
  A fusão de uma vez só roda dentro da migration.

## [0.2.2] — 2026-05-29

Nós de Flow agora conseguem enviar mídia. Fecha a lacuna mais pedida
no feedback de usuário depois do lançamento dos Flows na v0.2.0 —
flows eram só texto e não conseguiam entregar uma fatura, recibo,
foto de produto, ou vídeo curto de demonstração no meio da conversa.

### Adicionado

- **Nó de flow `send_media`.** Envie uma imagem (PNG / JPEG / WebP),
  vídeo (MP4 / 3GP), ou documento (PDF, Word, Excel, PowerPoint, TXT)
  pro cliente a partir de qualquer ponto de um flow. Escolha um
  arquivo no builder, ele sobe pro novo bucket `flow-media` do
  Supabase Storage, e a Meta busca a URL pública na hora do envio.
  Legenda opcional (limite de 1024 caracteres, suporta interpolação
  `{{vars.X}}`); documentos também aceitam um nome de arquivo opcional
  exibido no chat de quem recebe. Avança automaticamente depois do
  envio — mesma semântica de suspensão do `send_message`.
  ([#156](https://github.com/ArnasDon/wacrm/pull/156))

### Migration required

Aplique no seu projeto Supabase antes de fazer deploy desta versão:

- `supabase/migrations/016_flow_media.sql` — faz duas coisas:
  1. Adiciona `'send_media'` à constraint CHECK de
     `flow_nodes.node_type`. Sem isso o nó `send_media` falha ao
     salvar com uma violação de constraint.
  2. Cria o bucket público `flow-media` do Supabase Storage (limite de
     16 MB por arquivo, lista de MIME permitidos de imagem / vídeo /
     documento) mais policies de RLS por usuário (prefixo de caminho =
     `auth.uid()`). Sem isso o seletor de arquivo do builder falha ao
     enviar. Mesmo formato do bucket `avatars` da migration 008 — o
     bucket é **público** pra que a Meta busque a URL sem credenciais.

A migration é idempotente e segura pra rodar de novo.

## [0.2.1] — 2026-05-26

Lançamento de correção de bug. Tampa uma perda silenciosa de mensagem
recebida que disparava quando dois usuários na mesma instância
salvavam o mesmo `phone_number_id` de WhatsApp.

### Corrigido

- **Mensagens de WhatsApp recebidas não somem mais silenciosamente**
  quando dois usuários reivindicaram o mesmo `phone_number_id`. Antes
  o webhook usava `.single()` pra buscar a configuração dona, o que dá
  erro `PGRST116` tanto pra 0 linhas *quanto* ≥2 linhas — o salvamento
  do segundo usuário colocava o banco no estado de ≥2 linhas e toda
  mensagem recebida era descartada enquanto o log reportava, de forma
  enganosa, *"No config found for phone_number_id"*. Três camadas de
  correção: `POST /api/whatsapp/config` agora devolve **409** quando
  outro usuário já reivindicou o número, a busca do webhook distingue
  0 linhas de ≥2 linhas e loga os `user_id`s em conflito, e uma nova
  constraint no banco (`UNIQUE(phone_number_id)`) previne o estado
  ruim na camada de armazenamento. Reportado em
  [#136](https://github.com/ArnasDon/wacrm/issues/136), corrigido em
  [#143](https://github.com/ArnasDon/wacrm/pull/143).

### Migration required

Aplique no seu projeto Supabase antes de fazer deploy desta versão:

- `supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql`
  — adiciona `UNIQUE(phone_number_id)` a `whatsapp_config`. **Falha
  de forma explícita com uma dica de resolução copiável** se já
  existirem linhas duplicadas; deduplicar automaticamente destruiria
  tokens criptografados, então quem opera escolhe qual linha fica com
  o número. Pra checar primeiro:

  ```sql
  SELECT phone_number_id, array_agg(user_id) AS owners, count(*) AS n
  FROM whatsapp_config
  GROUP BY phone_number_id
  HAVING count(*) > 1;
  ```

  Se isso devolver linhas, dê `DELETE` na(s) linha(s) duplicada(s) que
  quer descartar, depois rode a migration de novo.

### Nota sobre configurações multiusuário

O wacrm é intencionalmente **single-tenant por número de WhatsApp**. O
RLS em `conversations`/`messages` é `auth.uid() = user_id`, então um
segundo usuário fisicamente não consegue ler mensagens roteadas pra um
dono diferente — dois usuários compartilhando um número nunca foi
suportado. Se você precisa de múltiplos humanos atendendo a mesma
caixa de entrada, rode-os sob uma conta compartilhada.

## [0.2.0] — 2026-05-22

O lançamento dos **Flows**. Adiciona um engine de conversa de WhatsApp
sem código, ramificado, guiado por botão, que roda junto das
Automações. Também traz um seletor de cores com 5 temas em
Configurações e abre os Flows pra todos os usuários.

### Adicionado

#### Flows — conversas de chatbot ramificadas

- **Módulo + schema.** Novas tabelas `flows`, `flow_nodes`,
  `flow_runs`, `flow_run_events` com índices únicos parciais que
  impõem uma execução ativa por contato. `messages.content_type`
  ampliado pra aceitar `'interactive'`; coluna `interactive_reply_id`
  adicionada pra que a caixa de entrada renderize toques em
  botão/lista.
  ([#112](https://github.com/ArnasDon/wacrm/pull/112))
- **Engine de execução.** `dispatchInboundToFlows` interpreta toda
  mensagem recebida via webhook, decide se a mensagem é uma resposta
  numa execução ativa ou um gatilho novo, avança a máquina de estado, e
  reporta de volta pro webhook pra que mensagens consumidas não
  também disparem automações. Idempotente sobre o `message_id` da
  Meta.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))
- **UI de builder sem código** em `/flows`. Editor de lista linear com
  formulários de configuração por nó, validador ao vivo, status de
  rascunho/ativo/arquivado, e uma API REST de 5 rotas
  (`GET/POST /api/flows`, `GET/PUT/DELETE /api/flows/[id]`,
  `POST /api/flows/[id]/activate`, `GET /api/flows/[id]/runs`,
  `GET /api/flows/templates`).
  ([#115](https://github.com/ArnasDon/wacrm/pull/115))
- **Templates + tipos de nó v1.5.** Três templates iniciais (Menu de
  boas-vindas, Bot de FAQ, Captura de lead) clonáveis a partir do
  diálogo de novo flow. Três tipos de nó novos: `collect_input`
  (captura texto do cliente numa variável), `condition` (ramifica por
  var / tag / campo de contato), `set_tag` (adiciona ou remove uma
  tag). Interpolação `{{vars.X}}` em prompts de send_message +
  collect_input. Visualizador de histórico de execução por flow em
  `/flows/[id]/runs`.
  ([#117](https://github.com/ArnasDon/wacrm/pull/117))
- **Cron de limpeza de execuções obsoletas** em `GET /api/flows/cron`
  — marca execuções que passaram do timeout configurado (padrão 24h)
  como `timed_out` pra que conversas abandonadas liberem o contato
  pra novos gatilhos. Reusa `AUTOMATION_CRON_SECRET`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))

#### Temas de cor

- **5 temas de cor** (Violeta padrão, Esmeralda, Cobalto, Âmbar, Rosa)
  selecionáveis numa nova aba **Aparência** em Configurações.
  Variáveis CSS com escopo sob `html[data-theme="..."]`, aplicadas em
  tempo de execução via `dataset.theme`, persistidas em
  `localStorage`. Um script inline de boot em `layout.tsx` reproduz a
  escolha antes da primeira pintura pra não piscar o padrão.
  ([#132](https://github.com/ArnasDon/wacrm/pull/132))
- **Varredura de tokenização de tema** — toda classe Tailwind
  `violet-*` antes fixa no código foi substituída por tokens
  `primary` em ~49 arquivos. Escolher um tema não-violeta agora tema
  o app inteiro, não só o chrome.
  ([#133](https://github.com/ArnasDon/wacrm/pull/133))

### Alterado

#### Flows — soft-GA

- **Flows agora está disponível pra todo usuário autenticado.** O
  gate de beta por conta acabou; a entrada na barra lateral + o
  cabeçalho da página carregam um pequeno chip "Beta" como único sinal
  restante.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))
- **UX do editor**:
  - Identificadores internos `node_key` + `reply_id` por
    botão/linha escondidos atrás de uma revelação "Mostrar avançado"
    por nó.
    ([#118](https://github.com/ArnasDon/wacrm/pull/118))
  - Nós `send_list` podem ter múltiplas seções.
    ([#119](https://github.com/ArnasDon/wacrm/pull/119))
  - Cards de nó recolhidos mostram uma prévia de conteúdo de 1 linha
    por tipo de nó (trecho de texto, títulos de botão, resumo de
    condição, etc.).
    ([#120](https://github.com/ArnasDon/wacrm/pull/120))
  - Problemas de validação são clicáveis: pula pro nó com problema e o
    destaca.
    ([#121](https://github.com/ArnasDon/wacrm/pull/121))
  - Indicador "● Editado" de mudanças não salvas + proteção de reload
    via `beforeunload`.
    ([#122](https://github.com/ArnasDon/wacrm/pull/122))
  - Diálogo de novo flow agora de fato alarga pra caber os 3 cards de
    template (estava limitado a 384px por um `sm:max-w-sm` fixo do
    shadcn).
    ([#129](https://github.com/ArnasDon/wacrm/pull/129),
    [#131](https://github.com/ArnasDon/wacrm/pull/131))
  - Painel de validação fixado no fundo da viewport pra que a
    prontidão de ativação acompanhe o usuário rolando pelos nós.
    ([#130](https://github.com/ArnasDon/wacrm/pull/130))

#### Confiabilidade do engine

- **Incremento atômico de `execution_count`** via RPC SECURITY
  DEFINER — previne contagens perdidas quando dois webhooks iniciam
  execuções concorrentemente. Espelha o padrão do engine de
  automações.
  ([#124](https://github.com/ArnasDon/wacrm/pull/124))
- **Pré-carrega todos os flow_nodes uma vez por despacho** — um
  SELECT por mensagem recebida em vez de um por iteração do loop de
  avanço. Uma cadeia de auto-avanço de 5 nós agora custa 1 ida-e-volta,
  não 5.
  ([#125](https://github.com/ArnasDon/wacrm/pull/125))
- **Releitura desperdiçada eliminada** depois do reset de reprompt;
  `loadActiveRun` mudou pra `.limit(1)` defensivo pra que uma falha de
  migration gerando duplicatas não derrube o despacho.
  ([#126](https://github.com/ArnasDon/wacrm/pull/126))

### Segurança

- **PII removida do payload do evento `reply_received`** — o texto do
  cliente não é mais persistido em `flow_run_events.payload`; só o
  tamanho é. Um prompt `collect_input` perguntando "qual o número do
  seu cartão?" antes deixava o PAN sentado na tabela de eventos.
  ([#123](https://github.com/ArnasDon/wacrm/pull/123))
- **Comparação de segredo de cron em tempo constante** em
  `/api/flows/cron` (`crypto.timingSafeEqual`) pra fechar um canal
  lateral teórico de temporização na checagem do header
  `x-cron-secret`.
  ([#127](https://github.com/ArnasDon/wacrm/pull/127))

### Corrigido

- **`/flows` não redireciona mais espuriamente pra `/dashboard`** ao
  navegar pra lá. Causa raiz: `useAuth` virava `loading: false` antes
  da busca de perfil resolver. `use-auth` agora expõe um booleano
  separado `profileLoading`.
  ([#128](https://github.com/ArnasDon/wacrm/pull/128))

### Migration required

Aplique, em ordem, no seu projeto Supabase:

1. `supabase/migrations/010_flows.sql` — tabelas centrais dos Flows,
   índices, policies de RLS, e a ampliação do schema de `messages`.
2. `supabase/migrations/011_profile_beta_features.sql` — adiciona a
   coluna `profiles.beta_features`. Sobrevive pra futuros betas; Flows
   não a lê mais.
3. `supabase/migrations/012_flows_increment_counter.sql` — RPC de
   contador atômico. Sem isso o engine ainda roda mas
   `flows.execution_count` fica sujeito a corrida.

Cada migration é idempotente — segura pra rodar de novo se você não
tiver certeza se já aplicou uma anterior.

### Removido

- **`src/lib/flows/feature-flag.ts`** + seus testes. Flows está aberto
  pra todos os usuários; a coluna `profiles.beta_features` em si
  sobrevive pra futuros gates de beta.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))

---

## [0.1.1] — 2026-05-19

### Adicionado

- Ações de chat na caixa de entrada: reações de emoji, responder com
  citação, e copiar texto em mensagens individuais. Hover no desktop,
  toque longo no touch. Reações e respostas de saída são
  encaminhadas pro WhatsApp via Cloud API; reações e respostas por
  swipe recebidas de clientes chegam pelo webhook e aparecem em tempo
  real.

### Migration required

- Aplique `supabase/migrations/009_message_actions.sql` no seu
  projeto Supabase. Adiciona `messages.reply_to_message_id` e a nova
  tabela `message_reactions` (com RLS e realtime). A migration é
  idempotente — segura pra rodar de novo.

### Alterado

- O webhook não guarda mais reações recebidas de cliente como
  mensagens de texto falsas. Elas são gravadas em `message_reactions`
  em vez disso, então qualquer query customizada que contava reações
  como mensagens vai precisar de atualização.

---

## [0.1.0]

Lançamento inicial do template. CRM central: caixa de entrada,
contatos, pipelines, transmissões, automações (com um dreno de cron
pra passo de Espera), integração com WhatsApp Cloud API, autenticação
+ RLS do Supabase.
