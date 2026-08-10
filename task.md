# Tarefas — wacrm

> Registro do que já foi feito e do que ainda falta. Atualizar a cada
> sessão de trabalho (mover item de "Pendentes" pra "Feitas" quando
> entregar, adicionar item novo quando surgir um pedido ou um gap).

## Pendentes

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
