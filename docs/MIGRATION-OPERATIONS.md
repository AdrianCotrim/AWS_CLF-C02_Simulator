# Operação segura da migração de IDs

Este documento descreve o contrato para uma futura integração da migração de IDs
com a inicialização. A execução definitiva exige autorização separada. Esta etapa
não migra os arquivos reais, não altera a inicialização normal e não publica uma
release.

## Estados

O estado transacional e o marcador global são independentes:

- `legacy`: não há marcador global; os dados podem continuar usando `personal-NNN`
  e `local-NNN`. A aplicação não deve inferir conclusão apenas por IDs numéricos.
- `migration-pending`: existe uma transação em `preparing`, `backup-created`,
  `prepared`, `committing` ou `recovery-needed`. A inicialização deve bloquear
  leituras e escritas normais.
- `migration-completed`: a transação está em `completed` e o marcador global
  validado possui `schemaVersion: 2`.
- `recovered`: uma operação incompleta foi restaurada ao estado anterior. A
  aplicação deve permanecer bloqueada até uma decisão operacional explícita.
- `ambiguous`/`invalid`: estado ou marcador inválido. A aplicação deve falhar
  fechada e não tentar adivinhar a intenção.

O módulo `migrationStartupGuard.js` fornece a classificação, o bloqueio opt-in e
a gravação atômica do marcador. Ele não inicia a migração.

O servidor possui uma verificação equivalente atrás de
`MIGRATION_STARTUP_GUARD=test`. Essa opção exige os oito caminhos explícitos
(`QUESTIONS_FILE`, `LOCAL_QUESTIONS_FILE`, `PROGRESS_FILE`, `USER_DATA_FILE`,
`HISTORY_FILE`, `QUESTIONS_SEQUENCE_FILE`, `MIGRATION_STATE_FILE` e
`MIGRATION_SCHEMA_FILE`). Ela apenas bloqueia estados pendentes ou ambíguos; não
inicia migração e permanece desativada em instalações normais.

## Pré-requisitos para execução definitiva

1. Encerrar operações normais de escrita e estabelecer uma janela sem concorrência.
2. Criar backup externo dos seis arquivos:
   `questions.json`, `questions.local.json`, `questions.json.sequence.json`,
   `progress.json`, `history.json` e `user-data.json`.
3. Registrar tamanho e SHA-256 de cada arquivo.
4. Confirmar que as cópias usadas pelo ensaio possuem os mesmos hashes.
5. Confirmar espaço em disco, diretórios de backup e permissões.
6. Confirmar que não existe estado transacional pendente ou ambíguo.

## Ordem recomendada

1. Verificar o estado de inicialização.
2. Ler e validar os seis arquivos.
3. Criar o backup transacional completo.
4. Preparar todos os temporários.
5. Validar IDs, referências, snapshots, metadados e JSON preparado.
6. Substituir os arquivos individualmente.
7. Validar cada arquivo final e as relações cruzadas.
8. Manter o backup de recuperação.
9. Gravar o marcador global somente depois de todos os passos anteriores.
10. Reabrir os stores e verificar catálogo, progresso, histórico e banco de erros.

## Interrupção e recuperação

Qualquer falha antes do marcador global mantém a operação pendente. Não deve ser
iniciada uma segunda migração. A recuperação deve usar o manifesto e os checksums
do backup transacional, rejeitando manifestos inválidos ou caminhos não autorizados.

Após recuperação, os arquivos devem ser comparados aos hashes capturados antes da
operação. O backup não deve ser removido antes da validação final e deve ser
retido conforme a política de retenção operacional.

## Backups históricos

Backups anteriores à migração não são convertidos automaticamente. Uma futura
conversão deverá:

- criar um mapa global determinístico por backup;
- preservar referências órfãs e snapshots;
- rejeitar colisões, sem alocar IDs silenciosamente;
- escrever um novo backup versionado, sem sobrescrever o original;
- validar restauração em uma cópia antes de disponibilizá-lo.

## Critérios de aprovação

A operação somente pode ser considerada concluída quando:

- os seis arquivos finais forem válidos;
- os IDs e referências forem coerentes;
- o marcador global for gravado atomicamente;
- os stores iniciarem sem estado pendente;
- os hashes e contagens esperados forem registrados;
- o backup de recuperação continuar disponível;
- a autorização específica para dados reais estiver registrada.
