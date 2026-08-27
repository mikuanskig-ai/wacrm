# Tarefas — wacrm

> Registro do que já foi feito e do que ainda falta. Atualizar a cada
> sessão de trabalho (mover item de "Pendentes" pra "Feitas" quando
> entregar, adicionar item novo quando surgir um pedido ou um gap).

## Pendentes

- [ ] **Rename completo pra ZDelivery** — 14/08: só a pasta local
  mudou de lugar (`clients/zontalk/zdelivery/`), o resto ainda diz
  "wacrm": `package.json` (`name`), repo do GitHub
  (`mikuanskig-ai/wacrm`), path no VPS (`/opt/wacrm`,
  `wacrm.service`), e qualquer branding visível na UI. Rename de
  verdade (nome do produto, domínio se mudar, repo) é decisão maior,
  fica pra quando o dono da conta confirmar o escopo exato.
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
- [ ] **16 pedidos `ai_chat` da Concórdia com `conversation_id` nulo**
  (achado em 14/08 investigando a reclamação de impressão/cálculo,
  span 06/08 a 13/08) — provavelmente conversa apagada depois
  (`ON DELETE SET NULL` na FK), pedido em si continua íntegro. Não
  investigado a fundo, baixo risco aparente, mas vale confirmar que
  não é sintoma de algo pior.

## Feitas

### 2026-08-21 — Ferramenta `update_cart_item` (parte 1 do plano de 2 etapas)

- IA ganhou capacidade de reduzir/remover item do carrinho de verdade
  (`update_cart_item`, por número de linha — não por `product_id`,
  porque o mesmo produto pode estar em 2 linhas com observações
  diferentes). Antes ela só sabia detectar o problema e perguntar,
  nunca executar a correção — caso da Fabiane (20/08): confirmou "sim,
  apenas uma" e a IA não fez nada, conversa ficou parada até fechar.
- `view_cart` e "Order so far" agora numeram as linhas do carrinho.
- Parte 2 do plano (mudar `add_to_cart` de "soma" pra "define
  quantidade total") — revisado o fix que o Ederson subiu em paralelo
  (`fix/cart-readd-duplicate-guard`, mesclado): antes de somar num
  match exato, agora checa se alguma mensagem do cliente desde a
  última vez que aquela linha foi tocada realmente menciona o produto
  de novo (ou um `confirm_quantity_increase` explícito do modelo); se
  não, não soma, avisa o modelo e mantém a quantidade. Ataca a mesma
  causa raiz de forma mais cirúrgica do que mudar a semântica inteira
  da ferramenta. **Decisão: parte 2 fica em espera** — dar 1-2 semanas
  de produção rodando com o fix dele antes de decidir se ainda precisa
  de algo mais forte.
- Merge feito (`git merge mikuanskig-ai/main`, sem conflito), 1010/1010
  testes passando (as 5 falhas de timezone que carregava a sessão
  inteira também foram corrigidas por ele, `fix/env-dependent-test-flakiness`).
  Outras duas correções vieram junto: `place_order`'s `notes` ganhou
  descrição pra parar de duplicar pagamento/observação de item na
  notinha, e a notinha de impressão (`imprimir/page.tsx`) ganhou
  agrupamento visual de adicionais/observação, data/hora, canal,
  telefone e checkbox de conferido.
- **Pendência anotada pelo próprio Ederson**: a correção de layout da
  notinha só cobre a página de reimpressão no navegador — o agente de
  impressão térmica (`zdelivery-print-agent`) não recebeu o mesmo
  ajuste ainda. Fica pra próxima sessão.

### 2026-08-19 — Trava de código contra resumo de pedido inventado (Concórdia — Juan)

- Terceira ocorrência ao vivo do mesmo padrão (Francisco e Ederson em
  17/08, agora Juan): a IA monta um resumo de pedido completo e
  convincente sem nunca ter chamado `add_to_cart`/`calculate_delivery_fee`.
  Juan pediu 1 marmita G, IA confirmou certo, mas o resumo final
  inventou "2 marmitas G — R$64". Cliente percebeu na hora. `ai_cart`
  no banco confirmado vazio — resumo fabricado do zero, não duplicação.
- Reforço de prompt (0.10.12, 0.10.13) não segurou essa variação nova.
  Implementada trava de código: depois da IA gerar a resposta, se o
  texto menciona "Total" perto de um valor em dinheiro E o carrinho
  real está vazio, a mensagem é bloqueada antes de sair e a conversa
  vai pra um humano com aviso específico (🚨) — nunca chega o número
  inventado no WhatsApp do cliente.
- `hasCartItems` novo em `order-state.ts`, motivo de handoff
  `hallucinated_summary` novo em `handoff.ts`. 3 testes novos.
- Pendente de observar: essa é a trava reativa (impede o envio), não
  resolve a IA pular a ferramenta — se continuar acontecendo, vale
  reconsiderar a ideia de `view_cart` obrigatório antes de qualquer
  resumo (discutido antes, não implementado).

### 2026-08-19 — IA não achava a taxa do bairro "Guarujá" (Concórdia)

- Reportado com print: cliente Sirlei disse "jardim Guarujá" e depois
  "Bairro Guarujá" explicitamente, a IA repetiu "não encontrei a taxa,
  qual o bairro?" 3 vezes seguidas — mesmo o bairro estando cadastrado
  certinho (R$15). Cliente cancelou o pedido. Confirmado no banco:
  bairro existe, preço certo — o bug era no matching.
- Causa: `matchNeighborhood` só tinha match exato ou correção de erro
  de digitação por distância de edição; "jardim Guarujá" está 7
  edições de "Guarujá" (a palavra "jardim" inteira), longe do limite.
  Não dava pra simplesmente cortar "jardim" como prefixo (a Concórdia
  também tem "Jardim Veredas"/"Jardim Itália" cadastrados de verdade).
- Corrigido: novo nível de match por contenção (nome cadastrado
  aparece inteiro dentro do que o cliente disse, ou vice-versa —  só
  quando é o único candidato assim, nunca chuta em caso de colisão).
  Também: quando nada casa, a ferramenta agora sugere até 3 nomes
  próximos pra IA oferecer, em vez de repetir a mesma pergunta sem
  informação nova. Log de diagnóstico adicionado.
- 6 testes novos em `fee-engine.test.ts` cobrindo o caso exato, o caso
  ambíguo (não pode chutar), e as sugestões.

### 2026-08-17 — Merge da v10 (Ederson Marques): filtros na página de Pedidos

- Tag `v10` / branch `feat/pedidos-page-filters`, subida pelo Ederson
  direto em cima do commit mais recente da main (fast-forward, sem
  conflito). Reconferido tudo antes de mergear: tsc/eslint limpos,
  986/991 testes (mesmas 5 falhas pré-existentes), build limpo.
- Coluna Data/Hora + filtro de período (atalhos + calendário
  personalizado) na lista de Pedidos, detalhe do pedido passa a
  mostrar também data/hora/pagamento, e pedido novo nasce `confirmed`
  em vez de `pending_confirmation` (a impressão já disparava sempre,
  independente do status).
- Mergeado na main e publicado como **v0.11.0**. Ainda não deployado
  no VPS — falta `git pull` + build + restart.

### 2026-08-17 — Agente de impressão: checagem real de status antes de marcar "impresso"

- Gap achado investigando a reclamação de impressão do mesmo dia (ver
  item logo abaixo): tanto o envio pra impressora de rede (socket TCP)
  quanto pra impressora compartilhada do Windows (`copy /b`) só provam
  que os bytes foram aceitos — nunca que o papel de fato saiu. Sem
  papel, tampa aberta ou impressora offline (mas ainda alcançável)
  passavam batido, e o job ficava marcado "impresso" do mesmo jeito.
- Adicionada checagem best-effort ANTES de cada tentativa de impressão
  (`zdelivery-print-agent/src/printer.ts`, `checkPrinterStatus`):
  - Rede: consulta ESC/POS real-time status (`DLE EOT 1`/`4`) pela
    própria conexão TCP — offline e sem-papel.
  - Windows: WMI (`Win32_Printer` via PowerShell) — `WorkOffline` e
    `DetectedErrorState`.
  - **Sempre "falha aberta"**: impressora que não responde à consulta
    (comum em clone barato) ou compartilhamento que o WMI não acha
    conta como "não sei dizer" — nunca bloqueia a impressão. Só fala
    alguma coisa quando a impressora/Windows reporta um problema real,
    e nesse caso o job já vai pra `failed` com motivo legível em vez de
    um "impresso" falso.
  - Alvo de empacotamento corrigido `node20-win-x64` → `node22-win-x64`
    (cache do `pkg` não tem mais binário pré-compilado pro node20 —
    já estava documentado no README como limitação conhecida).
- `.exe` novo publicado em `v2.zontalk.shop/downloads/zontalk-print-agent.exe`.
  **Não é automático**: não existe mecanismo de auto-update — cada
  loja com o agente já instalado precisa baixar e trocar o `.exe`
  manualmente pra ganhar essa checagem (a Concórdia incluída).

### 2026-08-17 — Pedido fantasma: IA "confirmava" sem criar o pedido (Concórdia)

- Reclamação: "não está saindo os pedidos na impressora". Investigado
  ao vivo: fila de impressão 100% saudável (37/37 impressos em 5 dias,
  agente conectado e respondendo na hora da reclamação — `last_polled_at`
  literalmente a poucos minutos) — não era problema de impressora.
- Achado o problema real em duas conversas da mesma manhã:
  - Francisco: IA mandou "Pedido confirmado! 🎉 Já estou passando para
    a cozinha" — sem nenhum `delivery_order`/`print_job` criado.
    `add_to_cart`/`place_order` nunca foram chamados.
  - Ederson (pego a tempo, antes de virar pedido): resumo com "3x
    Marmita M", cliente perguntou "Porque 3?", IA "corrigiu" pra "1x"
    mas manteve Subtotal R$75 e Total R$87 idênticos — carrinho real
    vazio (`ai_cart: []`) o tempo todo.
- Causa raiz: mensagem de atendente humano (áudio, num caso claramente
  conversa interna da equipe sobre outro pedido, não pro cliente) era
  transcrita e entrava no histórico da IA marcada como `assistant`,
  indistinguível da própria fala da IA — ela lia a promessa do humano
  como se já tivesse feito a ação, e parava de chamar as ferramentas
  de verdade.
- Corrigido em [context.ts](src/lib/ai/context.ts): mensagem de
  atendente humano agora entra no histórico marcada explicitamente
  como não sendo a IA (`formatHumanAgentMessage`).
- **Não resolvido**: por que conversa interna da equipe está caindo no
  chat do cliente (provável mesmo número de WhatsApp usado pra equipe
  conversar entre si) — investigar depois.

### 2026-08-15 — IA dobrou quantidade do pedido do Bruno (Concórdia)

- Print mandado ao vivo: cliente pediu 3 marmitas M + 1 Coca 2L, IA
  anotou certo em duas respostas separadas ("Anotado: 3 marmitas M",
  "Anotado também: 1 Coca 2L"), mas o resumo final de confirmação
  mostrou 6 marmitas + 2 Cocas. Dono do restaurante já corrigiu na mão
  ("vou arrumar ali o pedido..."). Confirmado: não tem relação com o
  revert do cache/modelo (aconteceu depois, já em GPT-5.4).
- Reconstruído pela conversa: entre o último "Anotado" e o resumo
  final, o cliente mandou várias mensagens seguidas (endereço,
  localização, CNPJ, nota fiscal, forma de pagamento) — nesse meio
  tempo `add_to_cart` foi chamado de novo pros mesmos itens, e o
  merge por match exato (soma quantidade — é o comportamento certo
  pra "bota mais uma") dobrou tudo.
- **Não consegui confirmar 100% o mecanismo exato** — esse caminho de
  merge já causou 3 incidentes ao vivo antes (06/08 x2, 07/08) mas
  nunca teve log nenhum. Corrigido isso: `console.warn` em todo merge
  por match exato (produto, quantidade antes/depois, conversa) — na
  próxima ocorrência (se houver) dá pra confirmar com certeza.
- Prompt reforçado: checar o carrinho de "Order so far" antes de
  montar o resumo, nunca reconstruir chamando `add_to_cart` de novo.
  **Sem garantia de eliminar por completo** — é reforço de prompt, não
  trava de código.

### 2026-08-15 — Revertido: cache de prompt causou alucinação

- Reportado pelo dono da conta: depois do fix de cache de prompt
  (0.10.9), a IA começou a alucinar. Revertido o commit inteiro
  (`git revert`) — `buildSystemPrompt` volta a retornar string simples
  (sem `cacheableText`), reordenação de conteúdo desfeita, `cache_control`
  do Anthropic removido.
- No mesmo período, o administrador da Concórdia também tinha trocado
  o modelo de `openai/gpt-5.4` pra `meta-llama/llama-3.3-70b-instruct`
  (era uma das sugestões de custo dadas junto com o cache) — revertido
  de volta pro GPT-5.4 também, a pedido.
- **Nota honesta**: as duas mudanças (cache + troca de modelo)
  aconteceram no mesmo período, então não dá pra saber com certeza
  qual das duas causou a alucinação — Llama 3.3 70B é um modelo bem
  mais fraco que GPT-5.4 pra esse tipo de tarefa (cálculo preciso,
  respeitar guardrails rígidos), então é uma explicação pelo menos tão
  provável quanto a reordenação do prompt. Revertidas as duas por
  precaução; se quiser isolar a causa depois, dá pra reaplicar o cache
  sozinho (sem trocar de modelo) e observar.

### 2026-08-14 — Reorganização: pasta movida pra dentro de zontalk

- Anúncio: o wacrm vai passar a se chamar **ZDelivery** (Zontalk
  Delivery), CRM focado em delivery, parte do ecossistema Zontalk.
  Primeiro passo (organização): pasta movida de `clients/wacrm/wacrm/`
  pra `clients/zontalk/zdelivery/`, e o agente de impressão de
  `clients/wacrm/print-agent/` pra
  `clients/zontalk/zdelivery-print-agent/` — sem mudar nada de código,
  histórico de git preservado nos dois (confirmado: `git log` intacto,
  `git status` limpo, remotes preservados).
- **Nada mudou em produção** — deploy continua em `/opt/wacrm` no VPS,
  serviço continua `wacrm.service`, repo do GitHub continua
  `mikuanskig-ai/wacrm`. Só a organização local mudou. Rename completo
  (produto, repo, path do servidor) é item separado nas Pendentes.
- Memória (`project_zdelivery.md`) criada pra registrar isso — não
  existia memória nenhuma pro projeto até agora, apesar de semanas de
  trabalho nele.

### 2026-08-14 — Pente fino: reclamação de impressão + cálculo da Concórdia

- Pedido pelo dono da conta: pessoal do restaurante reclamou que "não
  estava imprimindo" e "a IA estava errando nos cálculos finais".
  Investigado com dado real em vez de suposição.
- **Impressão**: `print_jobs` das últimas 48h mostrou 16 pedidos,
  todos `printed` em segundos, zero erro — pipeline funcionando desde
  o fix de 12/08. Item "nunca testado em impressora real" das
  Pendentes fica resolvido por essa evidência (o pente fino cobriu
  isso).
- **Cálculo**: não era erro de aritmética (todo pedido no banco bate
  `subtotal + taxa = total`, isso é calculado em código, nunca pela
  IA) — era **duplicação de pedido**. Achado no histórico de mensagens:
  cliente pediu 4 marmitas P (R$95, impresso), corrigiu pra 2 marmitas
  48 segundos depois, e a IA — sem saber que já existia um pedido
  nesta conversa e sem ferramenta pra cancelá-lo — criou um SEGUNDO
  pedido (R$55) em vez de corrigir o primeiro. Cozinha recebeu duas
  notinhas pra um pedido só. Confirmado no banco: só essa uma
  ocorrência real na conta.
- Corrigido: `place_order` agora grava `lastPlacedOrderId` no estado
  da conversa; o resumo injetado no prompt avisa quando já existe
  pedido criado e instrui a cancelar antes de recriar; nova ferramenta
  `cancel_order` (mesmos efeitos colaterais de um cancelamento manual
  pelo painel — webhook + automação). Recusa cancelar automaticamente
  se o pedido já saiu pra entrega/foi entregue.
- 8 testes novos (delivery.test.ts + order-state.test.ts). Um bug real
  no próprio fake de teste foi pego no processo: `maybeSingle()`
  devolvia a referência viva da linha em vez de uma cópia, então o
  `.update()` alterava retroativamente o objeto que o código já tinha
  lido — mascararia exatamente o tipo de bug que o teste queria pegar.

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
- **Revertido em 15/08 — ver entrada acima ("Revertido: cache de
  prompt")**: causou alucinação na IA segundo relato do dono da conta.

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
