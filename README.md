# ZonTalk

Plataforma completa de atendimento, vendas e automação que centraliza
todos os canais de comunicação da empresa em um único lugar — com um
diferencial: uma IA que **atende pelo WhatsApp e monta o pedido
sozinha**, do primeiro "oi" até a impressão na cozinha.

## IA que tira pedido (módulo Delivery)

O carro-chefe da plataforma. A IA conversa com o cliente em linguagem
natural, monta o carrinho certo, calcula frete por bairro/distância,
confirma forma de pagamento e envia o pedido direto pra impressão na
cozinha — sem um atendente digitar nada. Quando algo foge do script
(um pedido mais complexo, uma dúvida fora do previsto), a IA passa o
atendimento pra um humano com o contexto já resumido, e a equipe tem
uma tela de revisão pra forçar a impressão manualmente se precisar.

Pra operações que preferem não depender de IA, existe também um fluxo
de pedido 100% determinístico — menu por número, sem interpretação de
texto livre — como alternativa de baixo risco.

## O CRM por trás

- Caixa de entrada compartilhada, com distribuição de atendimento
  entre operadores e histórico completo por cliente.
- CRM em Kanban para gestão comercial — funil de vendas, oportunidades,
  negociações.
- Construtor de fluxo visual (chatbot sem código) para atendimento,
  qualificação de leads e — no módulo Delivery — pedidos por menu.
- Automações: distribuição de atendimento, mensagens automáticas e
  agendadas, respostas rápidas.
- Disparo de mensagens em massa (campanhas).
- Base de conhecimento com busca semântica, pra IA responder dúvidas
  com a informação real do negócio.
- Gestão de contatos, etiquetas, usuários e permissões.
- API pública para integrações externas ([docs/public-api.md](./docs/public-api.md)).
- Dashboard com métricas em tempo real.
- PWA — acesso de qualquer dispositivo, sem instalar nada.

## Stack

Next.js (App Router) + Supabase (Postgres, Auth, Storage) + Tailwind.
Self-hostável — roda na sua própria infraestrutura, sem depender de
nenhum serviço da ZonTalk.

## Para desenvolvedores

Este repositório é um fork ativo de um template self-hostável. Pra
rodar localmente, fazer deploy ou entender a estrutura do projeto, veja
[CONTRIBUTING.md](./CONTRIBUTING.md) — inclui o passo a passo de
setup, as migrations do Supabase e os scripts do dia a dia
(`npm run dev`, `npm test`, etc.).

Documentação adicional em [`docs/`](./docs).

## Licença

MIT — ver [LICENSE](./LICENSE).
