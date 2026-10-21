# AWS CLF-C02 Simulator

Ferramenta pessoal e local para praticar questões do exame AWS Certified Cloud Practitioner. O simulador usa HTML, CSS, JavaScript puro e JSON; o backend Express local persiste o progresso e expõe a API do banco de questões.

## Como executar

### Aplicativo Electron

Para executar a versão desktop em desenvolvimento:

```powershell
npm install
npm run electron:dev
```

Para gerar o instalador Windows NSIS:

```powershell
npm run dist:win
```

O instalador e a versão portátil de validação são gerados em `release/`. O pacote inclui o frontend, o backend e as dependências de produção; Node.js e Python não são necessários no computador do usuário.

Na versão instalada, o seed distribuído do catálogo é vazio (`distribution/questions.json`), para que questões pessoais não sejam incorporadas ao instalador. Questões locais, progresso, histórico, banco de erros, configurações e backups ficam no diretório de dados do usuário do Electron (`app.getPath('userData')`) e não são removidos pelo desinstalador padrão. O catálogo usado no desenvolvimento (`data/questions.json`) não é incluído no pacote.

### Atualizações pelo GitHub Releases

A versão empacotada consulta atualizações somente após iniciar normalmente e nunca baixa uma atualização sem confirmação. O provedor está configurado para o repositório público `AdrianCotrim/AWS_CLF-C02_Simulator`. No modo de desenvolvimento, nenhuma consulta é feita.

Para publicar uma versão:

1. Atualize o campo `version` em `package.json` usando uma versão semântica, por exemplo `1.0.1`.
2. Atualize as notas da versão.
3. Execute `npm install` e `npm run dist:win`.
4. Crie uma tag correspondente, por exemplo `v1.0.1`.
5. Crie uma GitHub Release para essa tag.
6. Anexe o instalador `.exe`, o arquivo `.blockmap` e o `latest.yml` gerados em `release/`.
7. Teste a detecção a partir da versão anterior instalada em uma VM.

O arquivo `latest.yml` e o instalador precisam permanecer disponíveis na release. O aplicativo apresenta a versão disponível e as notas, pergunta antes de baixar, mostra o progresso no título da janela e pergunta antes de instalar e reiniciar. Se a rede ou o GitHub estiverem indisponíveis, a versão instalada continua funcionando.

As atualizações substituem somente os arquivos da aplicação. Os dados em `app.getPath('userData')` não são migrados, reinicializados ou sobrescritos pelo atualizador. O instalador não possui assinatura digital configurada; alertas do SmartScreen podem ocorrer.

No Windows, inicie o backend e o frontend juntos com:

```powershell
.\start-app.bat
```

O iniciador reutiliza os servidores deste projeto se já estiverem ativos e abre `http://localhost:8000` no Brave, se instalado. Caso contrário, abre o navegador padrão.

Navegadores bloqueiam `fetch` de arquivos locais quando o `index.html` é aberto com duplo clique (`file://`). Por isso, sirva a pasta com um servidor estático simples:

```bash
cd aws-simulado
python -m http.server 8000
```

Depois acesse <http://localhost:8000>. Não é preciso internet. Qualquer servidor estático serve (`npx serve`, extensão Live Server do VS Code etc.). Para persistir o progresso e usar o formulário de cadastro, mantenha também a API local em execução (instruções abaixo).

## Modos

- **Todas**: questões do banco em ordem aleatória.
- **Questões novas**: só as que você nunca respondeu.
- **Banco de Erros**: questões erradas (ou marcadas como "Acertei por chute"). Acertar uma questão neste modo a remove do banco.
- **Simulado**: quantidade configurável (padrão 60), com botão "Anterior", cronômetro crescente e resultado final com o tempo utilizado. Opcionalmente, ative **Limite de tempo** e informe a duração em minutos (sugestão inicial: 90); ao esgotar o prazo, o simulado é finalizado automaticamente e o resultado identifica esse encerramento. O tempo restante é recuperado corretamente se você atualizar a página. Sem limite, o comportamento continua sendo o cronômetro crescente.

## Como adicionar questões

O catálogo aprovado fica em `data/questions.json`. Cadastros pela tela **Adicionar questão** são gravados separadamente em `data/questions.local.json`, sem regravar o catálogo. O backend gera IDs `local-NNN`, e a questão criada é incluída no simulador sem recarregar a página. No cadastro, marque **Adicionar ao Banco de Erros** para incluir também a referência da nova questão.

Ao salvar uma nova questão, o app compara o enunciado com os registros existentes após normalizar espaços, quebras de linha, HTML e maiúsculas/minúsculas. Se encontrar correspondências, permite cancelar, visualizar cada questão encontrada ou confirmar **Cadastrar mesmo assim**. A verificação ocorre apenas no envio e não altera o texto salvo.

Na visualização de uma questão em **Banco de Questões**, use **Adicionar ao Banco de Erros** ou **Remover do Banco de Erros** para alterar essa marcação a qualquer momento. O Banco de Erros é salvo no progresso persistido e referencia as questões pelo ID; os dados da questão não são copiados. Excluir uma questão não apaga o progresso nem o histórico associados ao ID.

## Estatísticas

A seção **Estatísticas** calcula respostas, acertos, erros, questões únicas, evolução diária, tópicos e sources a partir de `history`. Novas respostas guardam data, tópico e source no próprio registro; respostas antigas sem esses campos usam os dados atuais da questão quando ela ainda existe. O histórico de simulados e a recuperação de questões no Banco de Erros são contabilizados a partir dos registros com informação suficiente, sem inferir sessões completas retroativamente. Simulados concluídos também guardam o tempo decorrido e se foram encerrados por conclusão normal ou esgotamento do tempo; registros antigos sem essa informação continuam válidos e exibem o tempo como não disponível.

```json
{
  "id": "personal-001",
  "source": "Personal",
  "tag": "Conceitos de nuvem",
  "question": "O que é computação em nuvem?",
  "options": [
    "Faça backup de arquivos armazenados...",
    "Implantação de aplicativos conectados...",
    "Execução de código sem a necessidade...",
    "Fornecimento sob demanda..."
  ],
  "correct_answer": "Fornecimento sob demanda...",
  "explanation": "..."
}
```

| Campo | Obrigatório | Observação |
|---|---|---|
| `id` | sim | Único e estável. O progresso é ligado a ele; não reutilize IDs. |
| `source` | não | Origem (Personal, AWS Official, ExamTopics...). |
| `tag` | não | Categoria/tema da questão. |
| `question` | sim | Texto da questão. |
| `options` | sim | Array de strings com as alternativas, ou objeto `{ "A": "..." }` em formatos legados. |
| `correct_answer` | sim | Texto exato da alternativa correta, ou array de letras em formatos legados. |
| `explanation` | não | Só aparece se existir. |

O app aceita o formato atual do `questions.json` e também o formato antigo com `type`, `options` em objeto e `correct_answer` em array. Questões inválidas (ID duplicado, sem texto, alternativas ausentes, `correct_answer` incompatível) são ignoradas e listadas em um aviso no topo da página. O restante continua funcionando.

Em `multiple_choice`, a resposta só é correta quando o conjunto selecionado é igual ao conjunto de `correct_answer`, em qualquer ordem.

## Persistência organizada

A aplicação mantém a persistência em arquivos JSON locais, separados por responsabilidade:

- `data/questions.json`: banco principal usado no desenvolvimento; não é incluído na distribuição.
- `distribution/questions.json`: seed do catálogo incluído no aplicativo empacotado; permanece vazio para novas instalações.
- `data/questions.local.json`: cadastros, edições e exclusões locais, mantidos fora do catálogo padrão.
- `data/user-data.json`: questões pessoais, IDs no Banco de Erros e preferências do usuário. O formato inclui a versão dos dados para facilitar migrações futuras.
- `data/history.json`: histórico de tentativas, resultados e demais campos usados nas estatísticas.

As 763 questões atuais foram aprovadas como baseline para separar as alterações futuras; isso não afirma que sejam o catálogo original nem recupera questões anteriores ausentes. Edições e exclusões de questões do catálogo ficam registradas localmente como substituições e exclusões lógicas. O relatório de catálogo informa questões novas, alteradas, removidas e conflitos. Uma questão editada pode ser restaurada à versão padrão atual pela tela Banco de Questões. Os arquivos locais e backups não são distribuídos junto ao projeto.

Os acessos aos arquivos passam por módulos centralizados no backend (`backend/src/data`), evitando que cada tela ou componente escreva diretamente no disco. A API local continua aceitando os formatos atuais de questão e preserva o comportamento já existente do simulador.

## Persistência do progresso e migração

O progresso ativo do simulador é persistido pelo backend em `data/progress.json`, como documento JSON versionado. Ele contém o estado compatível com o frontend: dados por `questionId`, histórico de respostas, Banco de Erros e sessão de simulado retomável. Cada gravação é serializada, escrita por substituição atômica e relida para verificação. O rodapé informa quando o progresso está sendo salvo.

Na primeira execução após esta atualização, o app verifica a chave legada `clf-c02-progress` do LocalStorage. Se encontrar dados, mostra um resumo e pede confirmação antes de migrá-los. Se já houver progresso no backend, a substituição exige confirmação explícita; antes dela são criados backups separados dos estados atual e legado em `data/backups/`. A migração valida a estrutura e as referências da sessão, verifica a gravação e só então informa sucesso. O LocalStorage legado não é apagado nem recebe novas gravações. Se os dados forem inválidos ou a migração falhar, o erro é informado e o original permanece intacto.

O LocalStorage é consultado somente durante essa migração assistida. Assim, dados antigos ainda podem existir por navegador e endereço (`localhost:8000` e `localhost:5500` têm armazenamentos separados), mas não são mais a fonte ativa do progresso.

## Backup do progresso

- **Exportar progresso** baixa um arquivo JSON (`version`, `exportedAt`, `statistics`, `questionProgress`, `errorBank`, `history`).
- **Importar progresso** cria primeiro um backup de segurança no backend e, após confirmação, substitui o estado persistido; a sessão ativa não é importada.
- **Apagar progresso** remove o estado atual de `data/progress.json` após confirmação; `questions.json` não é afetado. O LocalStorage legado não é removido.

Faça backups periódicos e mantenha cópias fora da pasta do projeto.

## Backup completo e restauração

Use **Criar backup completo** para baixar um arquivo JSON versionado com as questões efetivas, o catálogo padrão, as alterações locais, a sequência de IDs, `user-data.json`, `history.json` e o progresso persistido. O progresso inclui `questionProgress`, histórico de respostas e a sessão de simulado em andamento, quando existente.

Use **Validar e restaurar backup** para selecionar um arquivo completo. A aplicação valida formato, versão, estrutura e checksums antes de mostrar o resumo e pedir confirmação. O formato atual usa `format: "aws-clf-c02-backup"` e `version: 2`; backups legados `version: 1` continuam aceitos e são restaurados como um catálogo baseline, sem classificação retroativa de origem. Os checksums SHA-256 detectam corrupção acidental; não autenticam o arquivo nem provam que seu conteúdo é confiável.

Antes de substituir os dados, o backend cria um backup de segurança com os arquivos JSON atuais, incluindo o progresso persistido, em `data/backups/`. Os arquivos são preparados em temporários e substituídos individualmente; se uma substituição falhar, o backend tenta reverter os arquivos já substituídos. Após a restauração, o frontend usa o progresso restaurado pelo backend.

A restauração de vários arquivos não é uma transação única: uma queda abrupta do processo ou uma falha durante o rollback ainda pode exigir recuperação manual usando o backup de segurança. Guarde também o arquivo baixado em outro local. A API requer os arquivos atuais `questions.json`, `user-data.json` e `history.json` para criar o backup e a cópia de segurança; se algum estiver ausente ou corrompido, a operação é recusada em vez de substituir silenciosamente por valores vazios. O arquivo de sequência pode estar ausente, pois nesse caso o próximo ID é derivado do maior ID atual.

O backup completo não inclui `node_modules`, caches ou logs, nem modifica a fonte oficial de persistência. O backend continua lendo e gravando os caminhos JSON atuais. O diretório `data/backups/` é a localização adequada ao projeto local atual; em uma futura distribuição Electron, os backups e demais dados graváveis devem ser movidos para o diretório de dados do usuário do aplicativo. O servidor do backend escuta somente em `127.0.0.1`, sem expor a API às interfaces de rede externas.

## API local de questões

No desenvolvimento, o simulador carrega o banco inicial de `data/questions.json`; no aplicativo empacotado, carrega o seed vazio de `distribution/questions.json`. A tela de cadastro usa a API local. Para instalar e iniciar a API, use Node.js 18 ou superior:

```bash
cd backend
npm install
npm run server
```

A API fica em `http://127.0.0.1:3000`; a porta pode ser alterada pela variável de ambiente `PORT`. O armazenamento continua sendo `data/questions.json`, na raiz do projeto. O backend não cria o arquivo automaticamente: se ele estiver ausente, a API responde com erro e não substitui o banco.

Endpoints disponíveis:

- `GET /api/progress`: lê o estado persistido e informa se ele existe.
- `PUT /api/progress`: valida e salva um snapshot completo do progresso.
- `POST /api/progress/migration/preview`: valida o progresso legado e retorna resumos do LocalStorage e do backend.
- `POST /api/progress/migration`: migra o progresso legado. Use `replaceExisting: true` somente após confirmação explícita para substituir progresso preexistente; a rota cria os backups antes de gravar.
- `POST /api/progress/import`: importa um estado validado após criar backup de segurança.
- `POST /api/backup/create`: cria um backup versionado usando o progresso persistido.
- `POST /api/backup/validate`: valida um bundle completo enviado em `{ backup: ... }`, sem gravar dados.
- `POST /api/backup/restore`: restaura um bundle validado enviado em `{ backup: ..., currentProgress: ... }`. Cria primeiro uma cópia de segurança dos dados atuais.
- `GET /api/questions`: retorna a lista efetiva composta pelo catálogo padrão e pelas alterações locais.
- `GET /api/questions/catalog-status`: informa atualizações do catálogo e conflitos com alterações locais; `POST /api/questions/catalog-status/acknowledge` registra que o relatório foi revisado.
- `GET /api/questions/:id/metadata`: informa se a questão é do catálogo ou local.
- `POST /api/questions/:id/restore-default`: remove a edição local e restaura a versão padrão atual.
- `GET /api/questions/:id`: retorna uma questão ou HTTP 404.
- `POST /api/questions`: valida e adiciona uma questão, retornando HTTP 201. O servidor gera o ID `local-NNN`; não envie `id`.
- `POST /api/questions/import`: faz pré-visualização ou confirma a importação em lote. Envie `{ questions: [...] }` e use `confirm: true` somente na confirmação final. A rota responde com resumo de itens válidos, duplicados e inválidos antes de gravar qualquer dado.
- `PUT /api/questions/:id`: valida e atualiza os campos da questão sem alterar o ID; responde HTTP 404 se não existir.
- `DELETE /api/questions/:id`: exclui uma questão local ou registra uma exclusão lógica da questão padrão; retorna seu ID e responde HTTP 404 se não existir.

Exemplo de questão para criação (o campo `correct_answer` pode ser a letra da alternativa ou seu texto):


```json
{
  "source": "Personal",
  "tag": "Conceitos de nuvem",
  "question": "Qual é outro nome para implantação on-premises?",
  "options": ["Nuvem privada", "Aplicativo baseado na nuvem", "Implantação híbrida", "Nuvem AWS"],
  "correct_answer": "A",
  "explanation": "Uma implantação on-premises também é chamada de implantação de nuvem privada."
}
```

Teste os endpoints no PowerShell enquanto o servidor estiver em execução:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/questions
Invoke-RestMethod http://127.0.0.1:3000/api/questions/personal-001
$body = @{ source = 'Personal'; tag = 'Conceitos de nuvem'; question = 'Enunciado atualizado?'; options = @('Alternativa A', 'Alternativa B'); correct_answer = 'A'; explanation = '' } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:3000/api/questions/personal-001 -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Delete -Uri http://127.0.0.1:3000/api/questions/personal-001
$body = @{ source = 'Personal'; tag = 'Conceitos de nuvem'; question = 'Exemplo de pergunta?'; options = @('Alternativa A', 'Alternativa B'); correct_answer = 'A'; explanation = 'A alternativa A está correta.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/questions -ContentType 'application/json' -Body $body
```

Para executar os testes automatizados da API, rode `npm test` dentro de `backend/`.

No simulador, **Banco de Questões** carrega a lista atual pela API e permite pesquisar por texto, Source e Tag, filtrar questões dentro ou fora do **Banco de Erros**, além de abrir os detalhes de cada questão. Ao entrar na área, os dados são atualizados do backend.

O POST altera o arquivo JSON persistente. Dados inválidos retornam HTTP 400 em JSON; erros de leitura, escrita ou arquivo corrompido retornam HTTP 500. CORS permite origens locais em `localhost` e `127.0.0.1` durante o desenvolvimento.

O DELETE pede confirmação na interface. Para questões padrão, a exclusão é lógica e pode ser revertida se a questão voltar a existir no catálogo; questões locais são removidas das alterações locais. Uma sequência auxiliar preserva o maior número já emitido, para que o backend não reutilize IDs antigos.

## Decisões de implementação

- Estatísticas contam cada questão uma vez, pelo resultado da última resposta (assim acertos + erros = respondidas).
- Fora do Simulado, a sessão percorre o conjunto filtrado e embaralhado uma vez e mostra o resultado ao final. Só o Simulado é persistido.
- Alternativas não são embaralhadas nesta versão.
- Categorias de motivo do erro (seção 17) não foram implementadas, apenas "Acertei por chute".
