// APIキーを利用するプロバイダーの一覧。新しいプロバイダーを追加する場合は
// ここにエントリを1つ追加すれば、設定画面・ウェルカム画面の両方に反映される。
export const providers = [
  {
    id: 'gemini',
    label: 'Gemini',
    defaultKeyPageUrl: 'https://aistudio.google.com/api-keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultKeyPageUrl: 'https://platform.openai.com/api-keys',
  },
];
