# AWS CLF-C02 Simulator

Ferramenta pessoal e local para praticar questões do exame AWS Certified Cloud Practitioner. O simulador continua usando HTML, CSS, JavaScript puro, JSON e LocalStorage. Um backend Express opcional, documentado abaixo, expõe uma API local para o banco de questões.

## Como executar

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

Depois acesse <http://localhost:8000>. Não é preciso internet. Qualquer servidor estático serve (`npx serve`, extensão Live Server do VS Code etc.). Para usar o formulário de cadastro, mantenha também a API local em execução (instruções abaixo).

## Modos

- **Todas**: questões do banco em ordem aleatória.
- **Questões novas**: só as que você nunca respondeu.
- **Banco de Erros**: questões erradas (ou marcadas como "Acertei por chute"). Acertar uma questão neste modo a remove do banco.
- **Simulado**: quantidade configurável (padrão 60), com botão "Anterior" e resultado final. Se você atualizar a página, o simulado em andamento é retomado.

## Como adicionar questões

Para editar o banco manualmente, inclua um objeto em `data/questions.json`. Também é possível cadastrar pela tela **Adicionar questão**: o formulário envia a questão à API, que gera o ID e grava no mesmo arquivo. A questão criada é incluída no simulador sem recarregar a página. No cadastro, marque **Adicionar ao Banco de Erros** para incluir também a referência da nova questão.

Ao salvar uma nova questão, o app compara o enunciado com os registros existentes após normalizar espaços, quebras de linha, HTML e maiúsculas/minúsculas. Se encontrar correspondências, permite cancelar, visualizar cada questão encontrada ou confirmar **Cadastrar mesmo assim**. A verificação ocorre apenas no envio e não altera o texto salvo.

Na visualização de uma questão em **Banco de Questões**, use **Adicionar ao Banco de Erros** ou **Remover do Banco de Erros** para alterar essa marcação a qualquer momento. O Banco de Erros continua sendo salvo no progresso do navegador, em `questionProgress`, e referencia as questões pelo ID; os dados da questão não são copiados. Excluir uma questão pela interface também remove seu progresso e sua referência ao Banco de Erros.

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

## LocalStorage

O progresso fica na chave `clf-c02-progress` do navegador. As questões nunca são gravadas lá, apenas dados de desempenho por `questionId`:

```json
{ "timesAnswered": 3, "timesWrong": 2, "lastAnswered": "2026-09-30", "lastCorrect": false, "inErrorBank": true }
```

Também ficam salvos o histórico de respostas, as estatísticas e o simulado em andamento. O LocalStorage não modifica `data/questions.json`; ele pode ser alterado manualmente ou pela API local documentada abaixo.

Limite: o LocalStorage pertence ao navegador e ao endereço usado (`localhost:8000` e `localhost:5500` têm armazenamentos separados). Limpar os dados do navegador apaga o progresso.

## Backup do progresso

- **Exportar progresso** baixa um arquivo JSON (`version`, `exportedAt`, `statistics`, `questionProgress`, `errorBank`, `history`).
- **Importar progresso** restaura esse arquivo, substituindo o progresso atual após confirmação.
- **Apagar progresso** remove tudo do LocalStorage após confirmação; o `questions.json` não é afetado.

Faça backups periódicos.

## API local de questões

O simulador carrega o banco inicial de `data/questions.json`; a tela de cadastro usa a API local. Para instalar e iniciar a API, use Node.js 18 ou superior:

```bash
cd backend
npm install
npm run server
```

A API fica em `http://localhost:3000`; a porta pode ser alterada pela variável de ambiente `PORT`. O armazenamento continua sendo `data/questions.json`, na raiz do projeto. O backend não cria o arquivo automaticamente: se ele estiver ausente, a API responde com erro e não substitui o banco.

Endpoints disponíveis:

- `GET /api/questions`: retorna a lista completa.
- `GET /api/questions/:id`: retorna uma questão ou HTTP 404.
- `POST /api/questions`: valida e adiciona uma questão, retornando HTTP 201. O servidor gera o ID `personal-NNN`; não envie `id`.
- `PUT /api/questions/:id`: valida e atualiza os campos da questão sem alterar o ID; responde HTTP 404 se não existir.
- `DELETE /api/questions/:id`: exclui a questão e retorna seu ID; responde HTTP 404 se não existir.

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
Invoke-RestMethod http://localhost:3000/api/questions
Invoke-RestMethod http://localhost:3000/api/questions/personal-001
$body = @{ source = 'Personal'; tag = 'Conceitos de nuvem'; question = 'Enunciado atualizado?'; options = @('Alternativa A', 'Alternativa B'); correct_answer = 'A'; explanation = '' } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri http://localhost:3000/api/questions/personal-001 -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Delete -Uri http://localhost:3000/api/questions/personal-001
$body = @{ source = 'Personal'; tag = 'Conceitos de nuvem'; question = 'Exemplo de pergunta?'; options = @('Alternativa A', 'Alternativa B'); correct_answer = 'A'; explanation = 'A alternativa A está correta.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/questions -ContentType 'application/json' -Body $body
```

Para executar os testes automatizados da API, rode `npm test` dentro de `backend/`.

No simulador, **Banco de Questões** carrega a lista atual pela API e permite pesquisar por texto, Source e Tag, além de abrir os detalhes de cada questão. Ao entrar na área, os dados são atualizados do backend.

O POST altera o arquivo JSON persistente. Dados inválidos retornam HTTP 400 em JSON; erros de leitura, escrita ou arquivo corrompido retornam HTTP 500. CORS permite origens locais em `localhost` e `127.0.0.1` durante o desenvolvimento.

O DELETE é permanente e a interface pede confirmação antes de executar. Uma sequência auxiliar de IDs preserva o maior número já emitido, para que a exclusão não faça o backend reutilizar IDs antigos.

## Decisões de implementação

- Estatísticas contam cada questão uma vez, pelo resultado da última resposta (assim acertos + erros = respondidas).
- Fora do Simulado, a sessão percorre o conjunto filtrado e embaralhado uma vez e mostra o resultado ao final. Só o Simulado é persistido.
- Alternativas não são embaralhadas nesta versão.
- Categorias de motivo do erro (seção 17) não foram implementadas, apenas "Acertei por chute".
