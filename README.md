# AWS CLF-C02 Simulator

Ferramenta pessoal e local para praticar questões do exame AWS Certified Cloud Practitioner. Usa apenas HTML, CSS, JavaScript puro, JSON e LocalStorage, sem backend e sem dependências.

## Como executar

Navegadores bloqueiam `fetch` de arquivos locais quando o `index.html` é aberto com duplo clique (`file://`). Por isso, sirva a pasta com um servidor estático simples:

```bash
cd aws-simulado
python -m http.server 8000
```

Depois acesse <http://localhost:8000>. Não é preciso internet. Qualquer servidor estático serve (`npx serve`, extensão Live Server do VS Code etc.).

## Modos

- **Todas**: questões do banco em ordem aleatória.
- **Questões novas**: só as que você nunca respondeu.
- **Banco de Erros**: questões erradas (ou marcadas como "Acertei por chute"). Acertar uma questão neste modo a remove do banco.
- **Simulado**: quantidade configurável (padrão 60), com botão "Anterior" e resultado final. Se você atualizar a página, o simulado em andamento é retomado.

## Como adicionar questões

Edite apenas `data/questions.json` e inclua um objeto na lista. Não é necessário alterar o código.

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

Também ficam salvos o histórico de respostas, as estatísticas e o simulado em andamento. O `questions.json` nunca é modificado.

Limite: o LocalStorage pertence ao navegador e ao endereço usado (`localhost:8000` e `localhost:5500` têm armazenamentos separados). Limpar os dados do navegador apaga o progresso.

## Backup do progresso

- **Exportar progresso** baixa um arquivo JSON (`version`, `exportedAt`, `statistics`, `questionProgress`, `errorBank`, `history`).
- **Importar progresso** restaura esse arquivo, substituindo o progresso atual após confirmação.
- **Apagar progresso** remove tudo do LocalStorage após confirmação; o `questions.json` não é afetado.

Faça backups periódicos.

## Decisões de implementação

- Estatísticas contam cada questão uma vez, pelo resultado da última resposta (assim acertos + erros = respondidas).
- Fora do Simulado, a sessão percorre o conjunto filtrado e embaralhado uma vez e mostra o resultado ao final. Só o Simulado é persistido.
- Alternativas não são embaralhadas nesta versão.
- Categorias de motivo do erro (seção 17) não foram implementadas, apenas "Acertei por chute".
