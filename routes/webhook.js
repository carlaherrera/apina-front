const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
require('dayjs/locale/pt-br');
dayjs.locale('pt-br');
const { diaDaSemanaExtenso } = require('../app/utils/dateHelpers');
const { logEstado } = require('../app/utils/logger');

/* ---------------------------------------------------------
   Configurações
--------------------------------------------------------- */
const boolSalvarConversa = false; // toggle para gravar no MongoDB
const responderComAudio = process.env.RESPONDER_COM_AUDIO === 'true'; // true para responder com áudio, false para texto

/* ---------------------------------------------------------
   Serviços externos
--------------------------------------------------------- */
const { enviarMensagemWhatsApp } = require('../services/twillioService');
const { gerarAudioUrl } = require('../services/elevenLabsService'); 
const { baixarAudioTwilio, transcreverAudioWhisper } = require('../services/transcribeService');
const {
  buscarClientePorCpf,
  buscarOSPorClienteId,
  atualizarOS,
  gerarSugestoesDeAgendamento,
  verificarDisponibilidadeData,
  // verificarDisponibilidade
} = require('../services/ixcService');
const {
  detectarIntentComContexto,
  gerarMensagemDaIntent,
  interpretarDataNatural,
  interpretarNumeroOS,
  interpretarEscolhaOS
} = require('../services/openaiService');

/* ---------------------------------------------------------
   Função adaptadora para substituir interpretaDataePeriodo
--------------------------------------------------------- */
async function interpretaDataePeriodo({ mensagem, agentId = 'default-agent', dados = {}, promptExtra = '' }) {
  try {
    // Tenta extrair a data e o período usando o serviço da OpenAI em uma única chamada
    const openAIResult = await interpretarDataNatural(
      mensagem,
      agentId,
      dados,
      promptExtra + ' Identifique a data e o período (manhã ou tarde) na frase do usuário: "' + mensagem + '". Responda APENAS com a data no formato YYYY-MM-DD e o período como "M" para manhã ou "T" para tarde, separados por vírgula. Exemplo: "2024-07-25,M". Se não identificar um período específico, use "T" como padrão para o período APENAS SE UMA DATA FOR IDENTIFICADA.'
    );

    console.log('====== RESULTADO interpretarDataNatural (data e período): ======');
    console.log(openAIResult);
    console.log('============================================================');

    let dataFinal = null;
    let periodoFinal = null;

    if (openAIResult && typeof openAIResult === 'object') {
      // Caso retorne objeto completo (nova estrutura)
      if (openAIResult.data_interpretada && dayjs(openAIResult.data_interpretada).isValid()) {
        dataFinal = openAIResult.data_interpretada;
      }
      if (openAIResult.periodo && ['M', 'T'].includes(openAIResult.periodo.toUpperCase())) {
        periodoFinal = openAIResult.periodo.toUpperCase();
      }
    } else if (openAIResult && typeof openAIResult === 'string') {
      const parts = openAIResult.split(',');
      if (parts.length > 0 && dayjs(parts[0].trim()).isValid()) {
        dataFinal = parts[0].trim();
      }
      if (parts.length > 1 && ['M', 'T'].includes(parts[1].trim().toUpperCase())) {
        periodoFinal = parts[1].trim().toUpperCase();
      }
    }


    // Se a OpenAI não retornou um período válido (M ou T), mas retornou uma data,
    // tentar usar a função local `interpretaPeriodo` como fallback.
    if (dataFinal && (!periodoFinal || !['M', 'T'].includes(periodoFinal))) {
      console.log('OpenAI não retornou período válido, tentando interpretaPeriodo localmente.');
      const periodoLocal = await interpretaPeriodo(mensagem);
      if (periodoLocal) {
        console.log('Período local encontrado:', periodoLocal);
        periodoFinal = periodoLocal;
      } else if (!periodoFinal && dataFinal) { // Se NENHUM período foi encontrado (nem OpenAI, nem local) E temos data
        console.log('Nenhum período específico encontrado, usando "T" (tarde) como padrão pois uma data foi identificada.');
        periodoFinal = 'T'; // Default para tarde se NENHUM período foi encontrado e temos data
      }
    }

    // Se ainda não temos data, mas temos período (cenário menos comum),
    // ou se não temos data de forma alguma, retorna null para indicar falha na extração completa.
    if (!dataFinal) {
      console.log('Nenhuma data válida foi interpretada.');
      return { data_interpretada: null, periodo_interpretado: periodoFinal }; // Retorna período se houver, mesmo sem data
    }

    // Retorna objeto com data e período
    return {
      data_interpretada: dataFinal,
      periodo_interpretado: periodoFinal
    };

  } catch (error) {
    console.error('Erro ao interpretar data e período:', error);
    return { data_interpretada: null, periodo_interpretado: null };
  }
}

/* ---------------------------------------------------------
   Função para interpretar o período (manhã/tarde) da mensagem
--------------------------------------------------------- */
async function interpretaPeriodo(mensagem) {
  try {
    if (!mensagem) return null;
    
    // Converter para minúsculas e remover acentos para facilitar a comparação
    const msgLower = mensagem.toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    
    // Palavras-chave para identificar período da manhã
    const keywordsManha = [
      'manha', 'manhã', 'matutino', 'cedo', 'antes do almoco', 'antes do almoço',
      'antes do meio dia', 'am', 'a.m', 'a.m.', 'de manha', 'pela manha', 'pela manhã',
      '08h', '09h', '10h', '11h', '8h', '9h', '10h', '11h', '8:00', '9:00', '10:00', '11:00',
      '8 horas', '9 horas', '10 horas', '11 horas',
      'oito horas', 'nove horas', 'dez horas', 'onze horas'
    ];
    
    // Palavras-chave para identificar período da tarde
    const keywordsTarde = [
      'tarde', 'vespertino', 'depois do almoco', 'depois do almoço', 
      'depois do meio dia', 'pm', 'p.m', 'p.m.', 'de tarde', 'pela tarde',
      '13h', '14h', '15h', '16h', '17h', '18h', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00',
      '1h', '2h', '3h', '4h', '5h', '6h', '1:00', '2:00', '3:00', '4:00', '5:00', '6:00', // Adicionado 1h-6h para tarde
      '13 horas', '14 horas', '15 horas', '16 horas', '17 horas', '18 horas',
      '1 hora', '2 horas', '3 horas', '4 horas', '5 horas', '6 horas', // Adicionado "X hora(s)" para tarde
      'uma hora', 'duas horas', 'tres horas', 'quatro horas', 'cinco horas', 'seis horas' // Adicionado por extenso para tarde
    ];
    
    // Verificar se a mensagem contém palavras-chave de manhã
    for (const keyword of keywordsManha) {
      if (msgLower.includes(keyword)) {
        console.log(`Período da manhã identificado pela palavra-chave local: ${keyword}`);
        return 'M';
      }
    }
    
    // Verificar se a mensagem contém palavras-chave de tarde
    for (const keyword of keywordsTarde) {
      if (msgLower.includes(keyword)) {
        console.log(`Período da tarde identificado pela palavra-chave local: ${keyword}`);
        return 'T';
      }
    }
    
    // Se não encontrou nenhum período específico, retorna null
    console.log('Nenhum período específico identificado localmente.');
    return null;
  } catch (error) {
    console.error('Erro ao interpretar período localmente:', error);
    return null;
  }
}

async function verificaClienteIdOuPedeCPF(user, contexto, intent) {
  console.log("================== intent ==================")  
  console.log("==================" + intent + "=============================")
  console.log("================== intent ==================")

  console.log("================== user ==================")  
  console.log("==================" + user + "=============================")
  console.log("================== user ==================")

  console.log("================== clienteId ==================")  
  console.log("==================" + user.clienteId + "=============================")
  console.log("================== clienteId ==================")

  console.log("================== clienteId ==================")  
  console.log("==================" + !user.clienteId + "=============================")
  console.log("================== clienteId ==================")
  if (!user.clienteId) {

    return false;
  }
  return true;
}

/**
 * Verifica se o usuário tem um clienteId e, se não tiver, define uma resposta apropriada.
 * Retorna true se o clienteId estiver presente, false caso contrário.
 * @param {Object} user - Objeto do usuário
 * @param {Object} respostaObj - Objeto com getter/setter para a resposta
 * @returns {boolean} - true se o clienteId estiver presente, false caso contrário
 */
async function ensureClienteId(user, respostaObj) {
  if (!user.clienteId) {
    // Se não temos o clienteId, precisamos pedir o CPF
    respostaObj.resposta = 'Por favor, me informe seu CPF para que eu possa identificar suas ordens de serviço.';
    user.etapaAtual = 'pedir_cpf';
    user.tipoUltimaPergunta = 'CPF';
    return false;
  }
  return true;
}

/**
 * Verifica se uma OS foi escolhida e, se não, tenta extrair uma da mensagem ou definir uma resposta apropriada.
 * @param {Object} user - Objeto do usuário
 * @param {Object} respostaObj - Objeto com getter/setter para a resposta
 * @param {string} mensagem - Mensagem do usuário
 * @param {string} contexto - Contexto da conversa
 * @param {string} intent - Intent atual
 * @param {Array} osList - Lista de OS disponíveis (opcional)
 * @returns {boolean} - true se uma OS foi escolhida ou definida, false caso contrário
 */
async function ensureOSEscolhida(user, respostaObj, mensagem, contexto, intent, osList) {
  // Se já temos uma OS escolhida, não precisamos fazer nada
  if (user.osEscolhida) {
    return true;
  }
  
  // Verificar se temos uma lista de OS
  if (!user.osList || user.osList.length === 0) {
    // Se não temos uma lista de OS, precisamos buscá-la primeiro
    if (!user.clienteId) {
      // Se não temos o clienteId, não podemos buscar as OS
      respostaObj.resposta = 'Precisamos do seu CPF para identificar suas ordens de serviço.';
      return false;
    }
    
    try {
      const lista = await buscarOSPorClienteId(user.clienteId);
      if (!lista || lista.length === 0) {
        respostaObj.resposta = 'Não encontrei nenhuma ordem de serviço para o seu CPF. Por favor, verifique se o CPF está correto ou entre em contato com o suporte.';
        return false;
      }
      user.osList = lista;
    } catch (error) {
      console.error('Erro ao buscar OS por clienteId:', error);
      respostaObj.resposta = 'Ocorreu um erro ao buscar suas ordens de serviço. Por favor, tente novamente mais tarde.';
      return false;
    }
  }
  
  // Se só temos uma OS na lista, podemos selecioná-la automaticamente
  if (user.osList.length === 1) {
    user.osEscolhida = user.osList[0];
    console.log(`Auto-selecionando a única OS disponível: ${user.osEscolhida.id}`);
    return true;
  }
  
  // Tentar extrair o número da OS da mensagem do usuário
  const resultado = await processarEscolhaOS({
    mensagem,
    contexto,
    intent,
    osList: user.osList
  });
  
  if (resultado && resultado.osObj) {
    user.osEscolhida = resultado.osObj;
    return true;
  }
  
  // Se não conseguimos extrair uma OS, precisamos pedir ao usuário para escolher uma
  let osMsg = '';
  if (user.osList.length > 0) {
    osMsg = 'Encontrei as seguintes ordens de serviço para você:\n';
    user.osList.forEach((os, index) => {
      const data = os.data_abertura ? dayjs(os.data_abertura).format('DD/MM/YYYY') : 'Data não disponível';
      const assunto = os.assunto || 'Assunto não disponível';
      osMsg += `${index + 1}. OS #${os.id} - ${assunto} (aberta em ${data})\n`;
    });
    osMsg += '\nPor favor, informe o número da OS ou a posição na lista (1, 2, etc) para a qual deseja verificar as datas disponíveis.';
  } else {
    osMsg = 'Não encontrei nenhuma ordem de serviço para você. Por favor, entre em contato com o suporte.';
  }
  
  respostaObj.resposta = osMsg;
  user.etapaAtual = 'escolher_os';
  return false;
}

const usuarios = {}; // { [numeroWhatsapp]: userState }

const extrairCpf = (texto = '') => {
  // Verifica se o texto se parece com um CPF no formato padrão (com ou sem pontuação)
  const m = texto.match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
  
  if (!m) return null;
  
  const cpfLimpo = m[0].replace(/[^\d]/g, '');
  
  // CPF sempre tem 11 dígitos - OS geralmente tem menos ou mais dígitos
  if (cpfLimpo.length !== 11) return null;
  
  // Verifica se os dígitos não são todos iguais (validação básica)
  if (/^(\d)\1{10}$/.test(cpfLimpo)) return null;
  
  return cpfLimpo;
};

const gerarPromptContextualizado = dados => {
  const l = [];

  if (dados.nome) l.push(`O usuário se chama ${dados.nome}.`);
  if (dados.cpf) l.push(`O CPF informado é ${dados.cpf}.`);

  /* ---------- 1) Lista resumida das OS abertas ---------- */
  if (Array.isArray(dados.osList) && dados.osList.length) {
    const resumo = dados.osList
      .map(o => `• ${o.id} - ${o.titulo || o.mensagem || 'Sem descrição'}`)
      .join(' / ');
    l.push(`OS abertas: ${resumo}.`);
  }

  /* ---------- 2) Detalhe da OS escolhida ---------- */
  if (dados.osEscolhida?.id) {
    const { id, titulo, mensagem, status } = dados.osEscolhida;
    l.push(
      `OS escolhida → ID ${id}` +
      (titulo ? ` | título: ${titulo}` : '') +
      (mensagem ? ` | desc.: ${mensagem}` : '') +
      (status ? ` | status: ${status}` : '')
    );
  }

  /* ---------- 3) Dados de sugestão de agendamento ---------- */
  if (dados.sugestaoData) {
    l.push(`Data sugerida para agendamento: ${dados.sugestaoData}.`);
  }
  if (dados.sugestaoPeriodo) {
    l.push(`Período sugerido para agendamento: ${dados.sugestaoPeriodo === 'M' ? 'manhã' : 'tarde'}.`);
  }

  /* ---------- 4) Resto dos campos ---------- */
  if (dados.etapaAnterior) l.push(`A etapa anterior foi "${dados.etapaAnterior}".`);
  if (dados.mensagemAnteriorGPT) l.push(`Mensagem anterior: "${dados.mensagemAnteriorGPT}".`);
  if (dados.mensagemAnteriorCliente) l.push(`Última mensagem do cliente: "${dados.mensagemAnteriorCliente}".`);
  if (dados.mensagemAtualCliente) l.push(`Nova mensagem do cliente: "${dados.mensagemAtualCliente}".`);
  if (dados.observacao) l.push(`Observação adicional: ${dados.observacao}.`);

  return l.join('\n');
};

const geraDados = (user, mensagemAtual, observacao = '') => ({
  intentAnterior: user.etapaAnterior,
  mensagemAnteriorGPT: user.mensagemAnteriorGPT,
  mensagemAnteriorCliente: user.mensagemAnteriorCliente,
  mensagemAtualCliente: mensagemAtual,
  etapaAnterior: user.etapaAnterior,
  cpf: user.cpf,
  sugestaoData: user.sugestaoData,
  sugestaoPeriodo: user.sugestaoPeriodo, // <- adiciona a sugestão de período também
  clienteId: user.clienteId,
  nome: user.nomeCliente,
  osList: user.osList,
  osEscolhida: user.osEscolhida,
  dataInterpretada: user.dataInterpretada,
  periodoAgendamento: user.periodoAgendamento,
  aguardandoConfirmacao: user.aguardandoConfirmacao,
  tipoUltimaPergunta: user.tipoUltimaPergunta,
  etapaAtual: user.etapaAtual,
  observacao
});

/**
 * Processa a escolha de uma OS com base na mensagem do usuário
 * @param {Object} params - Parâmetros da função
 * @param {string} params.mensagem - Mensagem do usuário
 * @param {Object} params.contexto - Contexto da conversa
 * @param {string} params.intent - Intent atual
 * @param {Array} params.osList - Lista de OS disponíveis
 * @returns {Object} - { osObj: Object, resposta: string }
 */
async function processarEscolhaOS({ mensagem, contexto, intent, osList }) {
  if (!osList || osList.length === 0) {
    return { resposta: 'Não há ordens de serviço disponíveis para agendamento.' };
  }

  try {
    // Tenta extrair o número da OS da mensagem
    const osPattern = /\b(\d{4,6})\b/; // Padrão para encontrar números de 4-6 dígitos (formato típico de OS)
    const osMatch = mensagem.match(osPattern);
    
    if (osMatch) {
      const osIdExtraido = osMatch[1];
      console.log(`Número de OS extraído da mensagem: ${osIdExtraido}`);
      
      // Verificar se a OS existe na lista
      const osEncontrada = osList.find(os => os.id === osIdExtraido);
      if (osEncontrada) {
        return { osObj: osEncontrada };
      }
    }
    
    // Se não encontrou pelo número, tenta interpretar a posição
    const posicao = await interpretarEscolhaOS({
      mensagem,
      osList,
      agentId: 'default-agent',
      dados: contexto,
      promptExtra: 'tente identificar a escolha da OS.'
    });
    
    if (posicao && osList[posicao - 1]) {
      return { osObj: osList[posicao - 1] };
    }
    
    // Se não conseguiu identificar, retorna mensagem solicitando escolha
    return { 
      resposta: 'Não consegui identificar qual OS você deseja. Por favor, informe o número da OS que deseja agendar.'
    };
  } catch (error) {
    console.error('Erro ao processar escolha de OS:', error);
    return { 
      resposta: 'Ocorreu um erro ao tentar identificar a OS. Por favor, informe o número da OS que deseja agendar.'
    };
  }
}

/**
 * Verifica se existe uma OS selecionada e tenta encontrar uma no contexto se não existir
 * @param {Object} user - Objeto do usuário
 * @param {string} mensagemPersonalizada - Mensagem personalizada opcional
 * @param {string} mensagem - Mensagem do usuário para tentar extrair o número da OS
 * @param {Object} contexto - Contexto da conversa
 * @param {string} intent - Intent atual
 * @returns {Object} - { osExiste: boolean, resposta: string, osObj: Object }
 */
async function verificarOSEscolhida(user, mensagemPersonalizada = null, mensagem = null, contexto = null, intent = null) {
  // Se já existe uma OS escolhida, retorna sucesso
  if (user.osEscolhida) {
    return { osExiste: true, osObj: user.osEscolhida };
  }
  
  // Se temos mensagem, contexto e a lista de OS, tenta interpretar a OS da mensagem
  if (mensagem && contexto && intent && user.osList && user.osList.length > 0) {
    try {
      console.log('Tentando identificar OS na mensagem:', mensagem);
      const resultado = await processarEscolhaOS({
        mensagem,
        contexto,
        intent,
        osList: user.osList
      });
      
      // Se encontrou uma OS, define no user e retorna sucesso
      if (resultado.osObj) {
        user.osEscolhida = resultado.osObj;
        console.log('OS identificada automaticamente:', resultado.osObj.id);
        return { osExiste: true, osObj: resultado.osObj };
      }
      
      // Se não encontrou mas temos uma resposta personalizada do processamento
      if (resultado.resposta) {
        return { osExiste: false, resposta: resultado.resposta };
      }
    } catch (error) {
      console.error('Erro ao tentar identificar OS na mensagem:', error);
    }
  }
  
  // Se não conseguiu identificar a OS ou não tinha informações suficientes
  const mensagemPadrao = 'Para continuar, preciso saber qual ordem de serviço você deseja. Pode me informar o número da OS?';
  return { 
    osExiste: false, 
    resposta: mensagemPersonalizada || mensagemPadrao 
  };
}

/* ---------------------------------------------------------
   Rota principal – Webhook Twilio
--------------------------------------------------------- */
router.post('/', express.urlencoded({ extended: false }), async (req, res) => { // Adicionado urlencoded para Twilio audio
  // Log da requisição completa para depuração (semelhante ao webhook_voz)
  console.log('--- [Webhook Unificado] INCOMING REQUEST ---');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));

  let mensagem = '';
  if (typeof req.body.Body === 'string') {
    mensagem = req.body.Body.trim();
  } else if (req.body.Body) {
    mensagem = String(req.body.Body).trim();
  } else {
    mensagem = '';
  }
  const numero = req.body.From;
  const audioUrl = req.body.MediaUrl0;

  if (!mensagem && audioUrl) {
    try {
      console.log('[Webhook Unificado] Baixando áudio do Twilio:', audioUrl);
      const audioBuffer = await baixarAudioTwilio(audioUrl);
      console.log('[Webhook Unificado] Áudio baixado, enviando para transcrição...');
      const textoTranscrito = await transcreverAudioWhisper(audioBuffer, 'audio.ogg'); // Assumindo ogg, ajuste se necessário
      mensagem = textoTranscrito || '(Áudio recebido, mas não foi possível transcrever)';
      console.log('[Webhook Unificado] Texto transcrito:', mensagem);
    } catch (err) {
      console.error('[Webhook Unificado] Erro ao processar/transcrever áudio:', err.message);
      mensagem = 'Recebi um áudio, mas ocorreu um erro ao tentar processá-lo.';
    }
  }

  if (!mensagem) {
    console.log('[Webhook Unificado] Nenhuma mensagem de texto ou áudio válido recebido. Usando mensagem padrão.');
    mensagem = 'Não entendi o que você disse ou enviou.'; 
  }

  /* -------------------- 1. Recupera/Cria sessão ------------------- */
  const user = usuarios[numero] ?? {
    numero, // Garante que o número sempre está presente
    etapa: 'inicio', etapaAnterior: '', etapaAtual: 'inicio',
    mensagemAnteriorGPT: '', mensagemAnteriorCliente: '',
    cpf: null, clienteId: null, nomeCliente: null,
    osList: [], osEscolhida: null,           // osEscolhida é SEMPRE objeto
    dataInterpretada: null, periodoAgendamento: null
  };
  // Sempre sincroniza o número na sessão
  user.numero = numero;

  /* -------------------- 2. Gera contexto p/ LLM ------------------- */
  const dados = geraDados(user, mensagem);
  const contexto = gerarPromptContextualizado(dados);
  let resposta = '';

  try {
    /* -------------------- 3. Detecta INTENT ----------------------- */
    console.log('🟦 [DEBUG] Chamando detectarIntentComContexto com:', {
      mensagem,
      agentId: 'default-agent',
      promptExtra: contexto,
      intentAnterior: user.etapaAnterior,
      mensagemAnteriorGPT: user.mensagemAnteriorGPT
    });
    let intentResult = null;
    try {
      intentResult = await detectarIntentComContexto({
        mensagem, // Usa a mensagem (texto original ou transcrito)
        agentId: 'default-agent',
        promptExtra: contexto,
        intentAnterior: user.etapaAnterior,
        mensagemAnteriorGPT: user.mensagemAnteriorGPT
      });
      console.log('🟩 [DEBUG] Resultado detectarIntentComContexto:', intentResult);
    } catch (errIntent) {
      console.error('🟥 [ERRO] detectarIntentComContexto:', errIntent);
      throw errIntent;
    }
    const { intent } = intentResult;

    user.etapaAtual = intent;

    console.log("================== Nova Intent Detectada ==================")
    console.log("==================" + intent + "=============================")
    console.log("================== Nova Intent Detectada ==================")

    /* -------------------- 4. Fluxo principal ---------------------- */
      switch (intent) {

        case 'extrair_cpf':{
          resposta = user._respostaCPF;
          const cpf = extrairCpf(mensagem);
          
          // Verificar se o usuário pode estar tentando informar um número de OS em vez de CPF
          const possibleOsNumber = mensagem.replace(/[^\d]/g, '');
          const isLikelyOsNumber = possibleOsNumber.length !== 11 && possibleOsNumber.length > 0;
          
          if (!cpf) { 
            if (isLikelyOsNumber) {
              resposta = 'Parece que você digitou um número que pode ser uma OS. Para confirmar, por favor me informe seu CPF primeiro (11 dígitos, ex: 12345678900 ou 123.456.789-00), e depois poderei verificar suas ordens de serviço.';
            } else {
              resposta = 'Parece que o formato do CPF não está correto. Por favor, digite novamente com 11 dígitos (ex: 12345678900 ou 123.456.789-00).';
            }
          }
    
          user.cpf = cpf;
          let osAbertas = [];
          let osAgendadas = [];
          let cliente = null;
          try {
            console.log('[DEBUG] Chamando buscarClientePorCpf com CPF:', cpf);
            cliente = await buscarClientePorCpf(cpf);
            console.log('[DEBUG] Resposta buscarClientePorCpf:', JSON.stringify(cliente));
          } catch (errCliente) {
            if (errCliente.response) {
              // Axios error
              console.error('[ERRO] buscarClientePorCpf - status:', errCliente.response.status);
              console.error('[ERRO] buscarClientePorCpf - data:', errCliente.response.data);
              console.error('[ERRO] buscarClientePorCpf - headers:', errCliente.response.headers);
            } else {
              console.error('[ERRO] buscarClientePorCpf:', errCliente);
            }
            
            // Fornecer uma mensagem amigável ao usuário com base no tipo de erro
            if (errCliente.response && errCliente.response.status === 401) {
              resposta = 'Desculpe, estamos enfrentando problemas de autenticação com nosso sistema. Por favor, tente novamente mais tarde ou entre em contato com nosso suporte técnico.';
            } else if (errCliente.response && errCliente.response.status === 404) {
              resposta = 'Não encontramos nenhum cliente cadastrado com este CPF. Por favor, verifique se o número está correto ou entre em contato com nosso suporte para mais informações.';
            } else {
              resposta = 'Desculpe, ocorreu um problema ao buscar seus dados. Por favor, tente novamente mais tarde ou entre em contato com nosso suporte técnico.';
            }
            
            // Registrar o erro técnico apenas no log, não para o usuário
            console.error('Erro técnico completo:', (errCliente.response ? errCliente.response.status + ' - ' + JSON.stringify(errCliente.response.data) : errCliente.message));
            user.clienteId = null;
            user.nomeCliente = null;
            // Não precisamos sair do fluxo, apenas definimos a resposta e continuamos normalmente
            break;
          }
          
          console.log("================== mensagem ==================")  
          console.log("==================" + mensagem + "=============================")
          console.log("================== mensagem ==================")  
          console.log("================== cpf ==================")  
          console.log("==================" + cpf + "=============================")
          console.log("================== cpf ==================")  
          console.log("================== cliente ==================")
          console.log("==================" + JSON.stringify(cliente) + "=============================")
          console.log("==================================")
          if (!cliente?.cliente?.id) {
            resposta = cliente.mensagem || 'CPF não encontrado. Pode reenviar?';
            user.clienteId = null;
            user.nomeCliente = null;
          } else {
            user.clienteId = cliente.cliente.id;
            user.nomeCliente = cliente.cliente.razao;
    
            const lista = await buscarOSPorClienteId(user.clienteId);
            osAbertas = lista.filter(o => o.status === 'A');
            osAgendadas = lista.filter(o => o.status === 'AG');
            user.osList = lista.filter(o => ['A', 'AG', 'EN'].includes(o.status));
    
            let partes = [`✅ Cadastro localizado, ${user.nomeCliente}.`];
            
            // Auto-selecionar a OS se houver apenas uma aberta
            if (osAbertas.length === 1) {
              user.osEscolhida = osAbertas[0];
              const osInfo = `• ${user.osEscolhida.id} - ${user.osEscolhida.titulo || user.osEscolhida.mensagem || 'Sem descrição'}`;
              partes.push(`Encontrei 1 OS aberta:\n${osInfo}\n\nJá selecionei essa OS para você. Para quando gostaria de agendar a visita? (ex: segunda-feira a tarde, dia 25 pela manhã)`);
              user.etapaAtual = 'agendar_data';
            } else if (osAbertas.length > 1) {
              const listaAbertas = osAbertas.map(o => `• ${o.id} - ${o.titulo || o.mensagem || 'Sem descrição'}`).join('\n');
              partes.push(`Encontrei ${osAbertas.length} OS aberta(s):\n${listaAbertas}\nSe quiser, posso te ajudar a agendar uma visita. Informe o número da OS para agendar.`);
            }
            
            if (osAgendadas.length) {
              const listaAgendadas = osAgendadas.map(o => `• ${o.id} - ${o.titulo || o.mensagem || 'Sem descrição'}`).join('\n');
              partes.push(`Você já possui ${osAgendadas.length} OS agendada(s):\n${listaAgendadas}\nDeseja ver detalhes do dia da visita? Responda com o número da OS para mais informações.`);
            }
            
            if (!osAbertas.length && !osAgendadas.length) {
              partes.push('Não há OS abertas ou agendadas no momento.');
            }
            
            resposta = partes.join('\n\n');
          }
          break;
        }
        case 'recusar_cancelar': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          // Limpa variáveis relacionadas ao fluxo
          user.osEscolhida = null;
          user.dataInterpretada = null;
          user.periodoAgendamento = null;
          user.etapaAtual = 'inicio';
          user.etapaAnterior = '';
          resposta = 'Tudo bem, cancelei o processo para você. Se precisar retomar ou tiver outra dúvida, é só me chamar! 😊';
          break;
        }
        case 'mudar_de_os': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          // Limpar variáveis relacionadas ao agendamento
          user.dataInterpretada = null;
          user.periodoAgendamento = null;
          
          // Tentar extrair o número da OS da mensagem do usuário
          const osPattern = /\b(\d{4,6})\b/; // Padrão para encontrar números de 4-6 dígitos (formato típico de OS)
          const osMatch = mensagem.match(osPattern);
          let osIdExtraido = null;
          
          if (osMatch) {
            osIdExtraido = osMatch[1];
            console.log(`Número de OS extraído da mensagem: ${osIdExtraido}`);
            
            // Verificar se a OS existe na lista do usuário
            if (user.osList && user.osList.length > 0) {
              const osEncontrada = user.osList.find(os => os.id === osIdExtraido);
              if (osEncontrada) {
                user.osEscolhida = osEncontrada;
                user.etapaAtual = 'agendar_data';
                user.etapaAnterior = 'escolher_os';
                
                // Gerar sugestões de agendamento para a OS escolhida
                const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);
                user.sugestaoData = sugestoes.sugestao.data;
                user.sugestaoPeriodo = sugestoes.sugestao.periodo;
                
                // Formatar a data e o período para a mensagem
                const dataFormatada = dayjs(sugestoes.sugestao.data).format('DD/MM/YYYY');
                const diaSemana = diaDaSemanaExtenso(sugestoes.sugestao.data);
                // Capitalizar primeira letra do dia da semana
                const diaSemanaCapitalizado = diaSemana.charAt(0).toUpperCase() + diaSemana.slice(1);
                const periodoExtenso = sugestoes.sugestao.periodo === 'M' ? 'manhã' : 'tarde';
                const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
                
                resposta = `Ótimo! Vamos reagendar a ${assunto}. ` +
                          `Que tal ${diaSemanaCapitalizado}, dia ${dataFormatada}, no período da ${periodoExtenso}? ` +
                          `Está bom para você ou prefere outra data?`;
                break;
              }
            }
          }
          
          // Se não conseguiu extrair a OS ou a OS não foi encontrada
          user.osEscolhida = null;
          user.etapaAtual = 'escolher_os';
          user.etapaAnterior = '';
          
          // Mostrar as OS disponíveis para o usuário
          let mensagemOS = 'Sem problemas! Vamos reagendar uma ordem de serviço. ';
          
          if (user.osList.length > 0) {
            const abertas = user.osList.filter(os => os.status === 'A');
            const agendadas = user.osList.filter(os => os.status === 'AG');
            
            if (abertas.length > 0) {
              mensagemOS += '\n\nOS abertas para agendar:';
              abertas.forEach(os => {
                mensagemOS += `\n• ${os.id} - ${os.titulo || os.mensagem || 'Sem descrição'}`;
              });
            }
            
            if (agendadas.length > 0) {
              mensagemOS += '\n\nOS já agendadas que podem ser reagendadas:';
              agendadas.forEach(os => {
                const dataAgendada = os.data_agenda_final ? dayjs(os.data_agenda_final).format('DD/MM/YYYY') : 'Data não disponível';
                const assunto = os.assunto || 'Assunto não disponível';
                mensagemOS += `\n• ${os.id} - ${assunto} (agendada para ${dataAgendada})`;
              });
            }
            
            mensagemOS += '\n\nPor favor, me informe o número da OS que deseja reagendar.';
          } else {
            mensagemOS += 'No momento, não encontrei nenhuma OS disponível para reagendamento. Por favor, entre em contato com nosso suporte.';
          }
          
          resposta = mensagemOS;
          break;
        }
        case 'listar_opcoes': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          user.osEscolhida = null;
          // Monta lista de OS disponíveis
          let osMsg = 'Nenhuma OS disponível.';
          if (user.osList && user.osList.length) {
            osMsg = user.osList.map(o => `• ${o.id} - ${o.titulo || o.mensagem || 'Sem descrição'}`).join('\n');
          }
          // Monta lista de datas/horários sugeridos
          let datasMsg = 'Nenhuma sugestão disponível.';
          if (user.sugestaoData || user.sugestaoHora) {
            datasMsg = '';
            if (user.sugestaoData) datasMsg += `Data sugerida: ${user.sugestaoData}`;
            if (user.sugestaoHora) datasMsg += `${datasMsg ? ' | ' : ''}Período sugerido: ${user.sugestaoPeriodo === 'M' ? 'manhã' : 'tarde'}`;
          }
          resposta = `Aqui estão as opções disponíveis:\n\nOrdens de Serviço (OS):\n${osMsg}\n\nSe quiser escolher uma OS, basta me dizer o número. Para agendar, é só informar a data e o período (manhã ou tarde) que preferir!`;
          break;
        }
        case 'inicio': {
          // This check ensures that if a user somehow re-enters 'inicio' after providing CPF, they aren't asked again.
          // However, the primary goal of 'inicio' if no CPF is present, is to ask for it.
          if (!user.clienteId) {
             user._respostaCPF = await gerarMensagemDaIntent({
               intent: 'extrair_cpf', // Force CPF collection
               agentId: 'default-agent',
               dados: contexto, // dados might be minimal here
               promptExtra: 'Se apresente caso ainda não tenha feito, e peça o CPF para iniciar.'
             });
             resposta = user._respostaCPF;
             // Ensure etapaAtual is set to something that expects CPF input next, e.g., 'extrair_cpf'
            // user 'extrair_cpf'; 
          } else {
            // If client ID already exists, perhaps greet them or offer options.
            resposta = await gerarMensagemDaIntent({ intent, agentId: 'default-agent', dados: contexto, promptExtra: 'Saudação ao usuário já identificado.' });
          }
          break;
        }
        case 'aleatorio': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          // Verificar se o usuário está respondendo a uma sugestão de OS
          if (user.etapaAtual === 'escolher_os' && user.osList && user.osList.length > 0) {
            // Tentar extrair o número da OS da mensagem do usuário
            const osPattern = /\b(\d{4,6})\b/; // Padrão para encontrar números de 4-6 dígitos (formato típico de OS)
            const osMatch = mensagem.match(osPattern);
            
            if (osMatch) {
              const osIdExtraido = osMatch[1];
              console.log(`Número de OS extraído da mensagem: ${osIdExtraido}`);
              
              // Verificar se a OS existe na lista do usuário
              const osEncontrada = user.osList.find(os => os.id === osIdExtraido);
              if (osEncontrada) {
                // Definir a OS escolhida e atualizar a etapa
                user.osEscolhida = osEncontrada;
                user.etapaAtual = 'agendar_data';
                user.etapaAnterior = 'escolher_os';
                
                // Gerar sugestões de agendamento para a OS escolhida
                const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);
                user.sugestaoData = sugestoes.sugestao.data;
                user.sugestaoPeriodo = sugestoes.sugestao.periodo;
                
                // Formatar a data e o período para a mensagem
                const dataFormatada = dayjs(sugestoes.sugestao.data).format('DD/MM/YYYY');
                const diaSemana = diaDaSemanaExtenso(sugestoes.sugestao.data);
                // Capitalizar primeira letra do dia da semana
                const diaSemanaCapitalizado = diaSemana.charAt(0).toUpperCase() + diaSemana.slice(1);
                const periodoExtenso = sugestoes.sugestao.periodo === 'M' ? 'manhã' : 'tarde';
                const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
                
                resposta = `Ótimo! Vamos agendar a ${assunto}. ` +
                          `Que tal ${diaSemanaCapitalizado}, dia ${dataFormatada}, no período da ${periodoExtenso}? ` +
                          `Está bom para você ou prefere outra data?`;
                break;
              }
            }
          }
          
          // Se não for relacionado a uma sugestão de OS, continuar com o fluxo normal
          // The !user.cpf check is now redundant due to ensureClienteId
          if (['verificar_os', 'escolher_os', 'agendar_data', 'extrair_data', 'extrair_hora', 'confirmar_agendamento'].includes(user.etapaAnterior)) {
            resposta = await gerarMensagemDaIntent({ intent, agentId: 'default-agent', dados: contexto, promptExtra: 'Solicite que o cliente conclua a etapa anterior.' });
          } else {
            resposta = await gerarMensagemDaIntent({ intent, agentId: 'default-agent', dados: contexto });
          }
          break;
        }
        case 'verificar_os': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          const lista = await buscarOSPorClienteId(user.clienteId);
          const osAbertas = lista.filter(o => o.status === 'A' || o.status === 'EN');
          const osAgendadas = lista.filter(o => o.status === 'AG');
          user.osList = lista.filter(o => ['A', 'AG', 'EN'].includes(o.status));

          let partes = [];
          if (osAbertas.length) {
            const listaAbertas = osAbertas.map(o => `• ${o.id} - ${o.titulo || o.mensagem || 'Sem descrição'}`).join('\n');
            const plural = osAbertas.length > 1;
            partes.push(
              `OS aberta${plural ? 's' : ''} encontrada${plural ? 's' : ''} (${osAbertas.length}):\n${listaAbertas}\n\n` +
              `Gostaria de agendar ${plural ? 'alguma delas' : 'ela'}?`
            );
          }
          if (osAgendadas.length) {
            const listaAgendadas = osAgendadas.map(o => `• ${o.id} - ${o.titulo || o.mensagem || 'Sem descrição'}`).join('\n');
            const plural = osAgendadas.length > 1;
            partes.push(
              `OS agendada${plural ? 's' : ''} encontrada${plural ? 's' : ''} (${osAgendadas.length}):\n${listaAgendadas}\n\n` +
              `Gostaria de ver mais detalhes ou reagendar ${plural ? 'alguma delas' : 'ela'}?`
            );
          }
          if (!osAbertas.length && !osAgendadas.length) {
            partes.push('Não há OS abertas ou agendadas no momento.');
          }

          resposta = partes.join('\n\n');
          break;
        }
        case 'escolher_os': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          const resultado = await processarEscolhaOS({
            mensagem,
            contexto,
            intent,
            osList: user.osList
          });
          
          if (resultado.resposta) {
            resposta = resultado.resposta;
            break;
          }
          
          // Define a OS escolhida
          user.osEscolhida = resultado.osObj;

          // Verificar o status da OS selecionada
          if (user.osEscolhida.status === 'AG') {
            // OS já está agendada - perguntar se quer mais informações ou reagendar
            const dataAgendada = user.osEscolhida.data_agenda_final ? 
              dayjs(user.osEscolhida.data_agenda_final).format('DD/MM/YYYY') : 'data não definida';
            const periodoAgendado = user.osEscolhida.melhor_horario_agenda === 'M' ? 'manhã' : 'tarde';
            const diaSemanaAgendado = user.osEscolhida.data_agenda_final ? 
                                    diaDaSemanaExtenso(user.osEscolhida.data_agenda_final) : '';
            const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
            
            resposta = `Você selecionou a OS ${user.osEscolhida.id} (${assunto}) que já está agendada para ${diaSemanaAgendado}, ` +
                      `dia ${dataAgendada}, no período da ${periodoAgendado}.\n\n` +
                      `O que você gostaria de fazer?\n` +
                      `1. Ver mais detalhes desta OS\n` +
                      `2. Reagendar esta visita\n` +
                      `3. Voltar para a lista de OS`;
            break;
          }
          
          // Se a OS está aberta (status = 'A'), seguir com o fluxo normal de agendamento
          const slaHoras = user.osEscolhida.sla_horas || 72;
          const prioridade = 0; // ou obtenha do contexto/usuário
          const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida, slaHoras, prioridade);

          if (!sugestoes || !sugestoes.sugestao) {
            resposta = `Nenhum horário disponível para agendamento com os técnicos deste setor.`;
            break;
          }

          // Guarda todas as alternativas de datas disponíveis
          user.datasDisponiveis = sugestoes.alternativas;
          // Inicializa variável para armazenar a escolha do usuário
          user.datasDisponivelEscolhida = null;

          user.sugestaoData = sugestoes.sugestao.data;
          user.sugestaoPeriodo = sugestoes.sugestao.periodo; // Armazena o período (M/T) em vez do horário
          user.tipoUltimaPergunta = 'AGENDAMENTO';

          // Formatar a data e o período para a mensagem
          const dataFormatada = dayjs(sugestoes.sugestao.data).format('DD/MM/YYYY');
          const diaSemana = diaDaSemanaExtenso(sugestoes.sugestao.data);
          const periodoExtenso = sugestoes.sugestao.periodo === 'M' ? 'manhã' : 'tarde';
          const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;

          // Alternativas
          let alternativas = '';
          if (sugestoes.alternativas && sugestoes.alternativas.length > 0) {
            // Agrupa alternativas por data/periodo, evita duplicidade
            const alternativasUnicas = [];
            const seen = new Set([`${sugestoes.sugestao.data},${sugestoes.sugestao.periodo}`]); // Inicializa o Set com a sugestão principal para evitar duplicação
            
            for (const alt of sugestoes.alternativas) {
              if (!alternativasUnicas.some(a => a.data === alt.data && a.periodo === alt.periodo)) {
                alternativasUnicas.push(alt);
              }
              if (alternativasUnicas.length >= 3) break;
            }
            
            alternativas = alternativasUnicas.map(alt => {
              const dataAlt = dayjs(alt.data).format('DD/MM/YYYY');
              const diaAlt = diaDaSemanaExtenso(alt.data);
              const periodoAlt = alt.periodo === 'M' ? 'manhã' : 'tarde';
              return `• ${diaAlt}, ${dataAlt} pela ${periodoAlt}`;
            }).join('\n');
          }

          resposta = `Ótimo! Tenho uma sugestão para sua visita de ${assunto}! ` +
            `Que tal ${diaSemana}, dia ${dataFormatada}, no período da ${periodoExtenso}?` +
            (alternativas ? `\n\nSe preferir, também tenho:\n${alternativas}` : '') +
            `\n\nEstá bom para você ou prefere outra opção? Se preferir, posso verificar outras datas disponíveis.`;
          break;
        }
        case 'datas_disponiveis': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
            // If ensureOSEscolhida sets a response (e.g. "Não há ordens de serviço..." or asks to choose one), then break.
            if (resposta) break; 
            // Fallback if ensureOSEscolhida somehow fails to set user.osEscolhida and doesn't set a response.
            if (!user.osEscolhida) {
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de ver as datas disponíveis.';
                 break;
            }
          }
          // The call to verificarOSEscolhida is now redundant.

          // Se a OS já está agendada, informa e oferece opções
          if (user.osEscolhida.status === 'AG') {
            const dataAgendada = user.osEscolhida.data_agenda_final ? 
              dayjs(user.osEscolhida.data_agenda_final).format('DD/MM/YYYY') : 'data não definida';
            const periodoAgendado = user.osEscolhida.melhor_horario_agenda === 'M' ? 'manhã' : 'tarde';
            const diaSemanaAgendado = user.osEscolhida.data_agenda_final ? 
              diaDaSemanaExtenso(user.osEscolhida.data_agenda_final) : '';
            const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
            
            resposta = `Você selecionou a OS ${user.osEscolhida.id} (${assunto}) que já está agendada para ${diaSemanaAgendado}, ` +
                      `dia ${dataAgendada}, no período da ${periodoAgendado}.\n\n` +
                      `O que você gostaria de fazer?\n` +
                      `1. Ver mais detalhes desta OS\n` +
                      `2. Reagendar esta visita\n` +
                      `3. Voltar para a lista de OS`;
            break;
          }

          // Buscar sugestões de agendamento usando a OS completa
          const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);
          user.sugestoesAgendamento = sugestoes;

          if (!sugestoes || !sugestoes.sugestao) {
            resposta = 'Não há horários disponíveis para agendamento no momento.';
            break;
          }

          // Formatar mensagem amigável com sugestão principal e até 3 alternativas
          const dataSug = sugestoes.sugestao.data;
          const periodoSug = sugestoes.sugestao.periodo;

          // Armazenar a sugestão principal para uso na confirmação
          user.sugestaoData = dataSug;
          user.sugestaoPeriodo = periodoSug;
          console.log(`[DEBUG] Sugestão principal armazenada para confirmação: Data=${user.sugestaoData}, Período=${user.sugestaoPeriodo}`);

          const dataFormatada = dayjs(dataSug).format('DD/MM/YYYY');
          const diaSemana = diaDaSemanaExtenso(dataSug);
          const periodoExtenso = periodoSug === 'M' ? 'manhã' : 'tarde';
          const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;

          // Alternativas
          let alternativas = '';
          if (sugestoes.alternativas && sugestoes.alternativas.length > 0) {
            // Filtra a sugestão principal para não aparecer nas alternativas
            const principalKey = `${sugestoes.sugestao.data}-${sugestoes.sugestao.periodo}`;
            
            // Agrupa alternativas por data/periodo, evita duplicidade
            const alternativasUnicas = [];
            const seen = new Set([principalKey]); // Inicializa o Set com a sugestão principal para evitar duplicação
            
            for (const alt of sugestoes.alternativas) {
              if (!alternativasUnicas.some(a => a.data === alt.data && a.periodo === alt.periodo)) {
                alternativasUnicas.push(alt);
              }
              if (alternativasUnicas.length >= 3) break;
            }
            
            alternativas = alternativasUnicas.map(alt => {
              const dataAlt = dayjs(alt.data).format('DD/MM/YYYY');
              const diaAlt = diaDaSemanaExtenso(alt.data);
              const periodoAlt = alt.periodo === 'M' ? 'manhã' : 'tarde';
              return `• ${diaAlt}, ${dataAlt} pela ${periodoAlt}`;
            }).join('\n');
          }

          resposta = `Ótimo! Tenho uma sugestão para sua visita de ${assunto}! ` +
            `Que tal ${diaSemana}, dia ${dataFormatada}, no período da ${periodoExtenso}?` +
            (alternativas ? `\n\nSe preferir, também tenho:\n${alternativas}` : '') +
            `\n\nEstá bom para você ou prefere outra opção? Se preferir, posso verificar outras datas disponíveis.`;
          break;
        }
        case 'extrair_data': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          // OS is needed for `verificarDisponibilidade` later in this case.
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
            if (resposta) break;
            if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de agendar.';
                 break;
            }
          }
          // At this point, user.osEscolhida should be set.

          const interpretacao = await interpretaDataePeriodo({
            mensagem,
            agentId: 'default-agent',
            dados: contexto,
            promptExtra: 'Tentando extrair data e período da mensagem do usuário.'
          });

          console.log('Resultado interpretaDataePeriodo:', interpretacao);

          if (!interpretacao || !interpretacao.data_interpretada || !dayjs(interpretacao.data_interpretada).isValid()) {
            // Se não conseguiu interpretar a data, ou a data é inválida, pede para o usuário informar novamente.
            // Isso evita o loop onde o período é repetido, mas a data não é capturada.
            resposta = 'Não consegui entender a data informada. Por favor, poderia tentar novamente? Você pode usar "hoje", "amanhã" ou o dia do mês, como "dia 28".';
            user.etapaAtual = 'extrair_data'; // Mantém o usuário na mesma etapa.
            break;
          }

          user.dataInterpretada = interpretacao.data_interpretada;
          user.periodoAgendamento = interpretacao.periodo_interpretado; // Pode ser null se não encontrado

          // Verificar validade da data e disponibilidade
          if (user.osEscolhida) {
            const resultadoDisponibilidade = await verificarDisponibilidadeData(
              user.osEscolhida,
              {
                data: user.dataInterpretada,
                periodo: user.periodoAgendamento // pode ser null
              }
            );

            if (!resultadoDisponibilidade.disponivel) {
              const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
              let motivoIndisponibilidade = `não temos disponibilidade para ${dataFormatada}`;
              if(user.periodoAgendamento) {
                  const periodoTexto = user.periodoAgendamento === 'M' ? 'manhã' : 'tarde';
                  motivoIndisponibilidade += ` no período da ${periodoTexto}`;
              }
              
              if (resultadoDisponibilidade.motivo === 'Não é um dia útil') {
                  motivoIndisponibilidade = `a data ${dataFormatada} não é um dia útil`;
              }

              // Tentar gerar sugestões alternativas
              const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);
              
              if (sugestoes && sugestoes.sugestao) {
                const sugestaoData = dayjs(sugestoes.sugestao.data).format('DD/MM/YYYY');
                const sugestaoDiaSemana = diaDaSemanaExtenso(sugestoes.sugestao.data);
                const sugestaoPeriodo = sugestoes.sugestao.periodo === 'M' ? 'manhã' : 'tarde';
                
                resposta = `Infelizmente, ${motivoIndisponibilidade}. Mas tenho uma sugestão: ${sugestaoDiaSemana}, ${sugestaoData}, no período da ${sugestaoPeriodo}. Essa data funciona para você?`;
                
                user.sugestaoData = sugestoes.sugestao.data;
                user.sugestaoPeriodo = sugestoes.sugestao.periodo;
                user.aguardandoConfirmacao = true;
                user.tipoUltimaPergunta = 'AGENDAMENTO_SUGESTAO';
                user.etapaAtual = 'confirmar_agendamento';
              } else {
                resposta = `Infelizmente, ${motivoIndisponibilidade}. Poderia escolher outra data ou período?`;
                user.dataInterpretada = null;
                user.periodoAgendamento = null;
                user.etapaAtual = 'extrair_data';
              }
              break;
            }
            
            // Se chegou aqui, a data é disponível.
            // Se o período não foi especificado, precisamos informar os períodos disponíveis.
            if (!user.periodoAgendamento && resultadoDisponibilidade.periodosDisponiveis && resultadoDisponibilidade.periodosDisponiveis.length > 0) {
                const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
                const periodosTexto = resultadoDisponibilidade.periodosDisponiveis.map(p => p === 'M' ? 'manhã' : 'tarde').join(' e ');
                resposta = `Para o dia ${dataFormatada}, temos disponibilidade no período da ${periodosTexto}. Qual você prefere?`;
                user.etapaAtual = 'extrair_hora'; // Pede para o usuário escolher o período
                break;
            }
          } else {
            // Verificação de final de semana genérica se não houver OS (improvável neste ponto do fluxo)
            const diaDaSemana = dayjs(user.dataInterpretada).day();
            if (diaDaSemana === 0 || diaDaSemana === 6) {
              const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
              const diaSemanaTexto = diaDaSemana === 0 ? 'domingo' : 'sábado';
              resposta = `Desculpe, não realizamos agendamentos para finais de semana. A data ${dataFormatada} é um ${diaSemanaTexto}. Por favor, escolha uma data de segunda a sexta-feira.`;
              user.dataInterpretada = null;
              user.periodoAgendamento = null;
              break;
            }
          }

          // Se temos data E período
          if (user.dataInterpretada && user.periodoAgendamento) {
            try {
              if (!user.osEscolhida && user.osList.length === 1) {
                user.osEscolhida = user.osList[0];
              }

              if (user.osEscolhida) {
                // A disponibilidade já foi verificada no bloco anterior.
                // Se chegamos aqui, a data e período são válidos e disponíveis.
                const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
                const diaSemana = diaDaSemanaExtenso(user.dataInterpretada);
                const periodoExtenso = user.periodoAgendamento === 'M' ? 'manhã' : 'tarde';
                const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
                
                resposta = `${diaSemana}, ${dataFormatada} pela ${periodoExtenso} está disponível para agendamento da OS ${user.osEscolhida.id} (${assunto}). Confirma o agendamento para essa data?`;
                user.sugestaoData = user.dataInterpretada;
                user.sugestaoPeriodo = user.periodoAgendamento;
                user.tipoUltimaPergunta = 'AGENDAMENTO';
                user.aguardandoConfirmacao = true;
                user.etapaAtual = 'confirmar_agendamento';
              } else {
                // Fallback case
                resposta = `Entendi que o agendamento seria para ${dayjs(user.dataInterpretada).format('DD/MM/YYYY')} no período da ${user.periodoAgendamento === 'M' ? 'manhã' : 'tarde'}. Para qual OS seria?`;
                user.etapaAtual = 'escolher_os';
              }
            } catch (error) {
              console.error('Erro ao preparar a confirmação do agendamento:', error);
              resposta = 'Desculpe, ocorreu um erro ao preparar a confirmação do agendamento. Por favor, tente novamente mais tarde.';
            }
          } else if (user.dataInterpretada && !user.periodoAgendamento) {
            // Temos data, mas FALTA período
            const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
            resposta = await gerarMensagemDaIntent({
              intent: 'extrair_hora', // Mudar para intent de pedir período
              agentId: 'default-agent',
              dados: contexto,
              promptExtra: `Ok, anotei a data ${dataFormatada}. Você prefere o período da manhã ou da tarde?`
            });
            user.etapaAtual = 'extrair_hora';
          } else {
            // Cenário inesperado ou dados insuficientes após a primeira tentativa de interpretação
             resposta = "Não consegui entender completamente sua solicitação de data e período. Pode tentar novamente, por favor? Exemplo: 'quero agendar para amanhã à tarde'.";
          }
          break;
        }
        case 'extrair_hora': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          // OS is needed for `verificarDisponibilidade` later.
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
            if (resposta) break;
            if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de agendar.';
                 break;
            }
          }
          // At this point, user.osEscolhida should be set.

          // Primeiro, tentar extrair data e período juntos da mensagem
          const interpretacaoCompleta = await interpretaDataePeriodo({ mensagem, agentId: 'default-agent', dados: contexto });
          
          let periodoInterp = null;
          let dataExtraida = null;
          
          // Se conseguiu extrair data e período juntos
          if (interpretacaoCompleta && interpretacaoCompleta.data_interpretada) {
            dataExtraida = interpretacaoCompleta.data_interpretada;
            periodoInterp = interpretacaoCompleta.periodo_interpretado;
            console.log('Extraído data e período juntos:', { data: dataExtraida, periodo: periodoInterp });
          } else {
            // Fallback: tentar extrair apenas o período
            periodoInterp = await interpretaPeriodo(mensagem);
            console.log('Extraído apenas período:', periodoInterp);
          }
          
          // Se um período válido (M/T) foi interpretado
          if (periodoInterp && ['M', 'T'].includes(periodoInterp)) {
            user.periodoAgendamento = periodoInterp;
          }

          // Se extraiu data junto com o período, usar a data extraída
          if (dataExtraida) {
            user.dataInterpretada = dataExtraida;
          }
          
          // Se não conseguiu extrair período válido
          if (!periodoInterp || !['M', 'T'].includes(periodoInterp)) {
            resposta = await gerarMensagemDaIntent({
              intent: 'faltando_hora', // Mudar para intent de pedir período
              agentId: 'default-agent',
              dados: contexto,
              promptExtra: 'Não consegui identificar o período. Por favor, diga se prefere manhã ou tarde.'
            });
            break;
          }
          // Restante do código para extrair_hora
          // ...
          // Agora verificar se temos data na sessão ou extraída
          if (!user.dataInterpretada) {
            // Se não temos data, mas temos período, pedir a data
            const periodoExtensoUser = user.periodoAgendamento === 'M' ? 'manhã' : 'tarde';
            resposta = `Entendi que você prefere o período da ${periodoExtensoUser}. Para qual data seria o agendamento?`;
            user.etapaAtual = 'extrair_data';
            break;
          }

          // Se temos data e período, verificar disponibilidade
          if (user.dataInterpretada && user.periodoAgendamento) {
            if (user.osEscolhida) {
              try {
                const resultadoDisponibilidade = await verificarDisponibilidadeData(
                  user.osEscolhida,
                  {
                    data: user.dataInterpretada,
                    periodo: user.periodoAgendamento
                  }
                );

                if (resultadoDisponibilidade.disponivel) {
                  const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
                  const diaSemana = diaDaSemanaExtenso(user.dataInterpretada);
                  const periodoExtenso = user.periodoAgendamento === 'M' ? 'manhã' : 'tarde';
                  const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
                  
                  resposta = `${diaSemana}, ${dataFormatada} pela ${periodoExtenso} está disponível para agendamento da OS ${user.osEscolhida.id} (${assunto}). Confirma o agendamento para essa data?`;
                  user.sugestaoData = user.dataInterpretada;
                  user.sugestaoPeriodo = user.periodoAgendamento;
                  user.tipoUltimaPergunta = 'AGENDAMENTO';
                  user.aguardandoConfirmacao = true;
                  user.etapaAtual = 'confirmar_agendamento';
                } else {
                  // Não disponível, gerar sugestões
                  const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
                  const periodoTexto = user.periodoAgendamento === 'M' ? 'manhã' : 'tarde';
                  let motivoIndisponibilidade = `não temos disponibilidade para ${dataFormatada} no período da ${periodoTexto}`;
                  if (resultadoDisponibilidade.motivo === 'Não é um dia útil') {
                      motivoIndisponibilidade = `a data ${dataFormatada} não é um dia útil`;
                  }

                  const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);

                  if (sugestoes && sugestoes.sugestao) {
                      const { data, periodo } = sugestoes.sugestao;
                      const dataFormatadaSugestao = dayjs(data).format('DD/MM/YYYY');
                      const periodoExtensoSugestao = periodo === 'M' ? 'manhã' : 'tarde';
                      const diaSemanaSugestao = diaDaSemanaExtenso(data);

                      resposta = `Infelizmente, ${motivoIndisponibilidade}. A próxima data disponível que encontrei é ${diaSemanaSugestao}, ${dataFormatadaSugestao}, no período da ${periodoExtensoSugestao}. Podemos agendar para essa data?`;
                      
                      user.sugestaoData = data;
                      user.sugestaoPeriodo = periodo;
                      user.tipoUltimaPergunta = 'AGENDAMENTO_SUGESTAO';
                      user.aguardandoConfirmacao = true;
                      user.etapaAtual = 'confirmar_agendamento';
                  } else {
                      resposta = `Desculpe, ${motivoIndisponibilidade} e não consegui gerar uma sugestão. Gostaria de tentar outra data?`;
                  }
                  break; // Sair após dar a sugestão ou a mensagem de erro.
                }
              } catch (error) {
                console.error('Erro ao verificar disponibilidade em extrair_hora:', error);
                resposta = 'Desculpe, ocorreu um erro ao verificar a disponibilidade. Por favor, tente novamente mais tarde.';
              }
            } else {
              resposta = `Entendi que o agendamento seria para ${dayjs(user.dataInterpretada).format('DD/MM/YYYY')} no período da ${user.periodoAgendamento === 'M' ? 'manhã' : 'tarde'}. Para qual OS seria?`;
              user.etapaAtual = 'escolher_os';
            }
          }
          break;
        }
        case 'alterar_periodo': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
             if (resposta) break;
             if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de alterar o período.';
                 break;
            }
          }
          // The call to verificarOSEscolhida is now redundant.
          
          // Extrair o período da mensagem (manhã ou tarde)
          const periodoInterp = await interpretaPeriodo(mensagem);
          console.log(`Período interpretado da mensagem: ${periodoInterp}`);
          
          if (!periodoInterp || !['M', 'T'].includes(periodoInterp)) {
            resposta = 'Não consegui identificar o período que você deseja. Por favor, especifique se prefere pela manhã ou pela tarde.';
            break;
          }

          // Manter a data atual, mas alterar o período
          user.periodoAgendamento = periodoInterp;
          
          // Se não tiver data interpretada, usar a data da sugestão
          if (!user.dataInterpretada && user.sugestaoData) {
            user.dataInterpretada = user.sugestaoData;
            console.log(`Usando data da sugestão: ${user.dataInterpretada} com o novo período: ${periodoInterp}`);
          }

          if (!user.dataInterpretada) {
            resposta = 'Precisamos de uma data para o agendamento. Pode me informar qual data você prefere?';
            break;
          }

          // Verificar a disponibilidade para o período solicitado
          const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida, {
            dataEspecifica: user.dataInterpretada,
            periodoEspecifico: periodoInterp
          });

          if (!sugestoes || !sugestoes.sugestao) {
            resposta = `Desculpe, não encontrei disponibilidade para ${dayjs(user.dataInterpretada).format('DD/MM/YYYY')} no período da ${periodoInterp === 'M' ? 'manhã' : 'tarde'}. Gostaria de tentar outra data ou período?`;
            break;
          }

          // Formatar a data e o período para a mensagem usando os valores escolhidos pelo usuário
          const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
          const diaSemana = diaDaSemanaExtenso(user.dataInterpretada);
          const periodoExtenso = user.periodoAgendamento === 'M' ? 'manhã' : 'tarde';
          const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
          
          resposta = `Ótimo! Confirmando a alteração para ${diaSemana}, dia ${dataFormatada}, no período da ${periodoExtenso}. Posso confirmar o agendamento?`;
          break;
        }
        case 'agendar_data': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
             if (resposta) break;
             if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de agendar.';
                 break;
            }
          }

          if (user.osEscolhida) { 
            const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);
            user.sugestoesAgendamento = sugestoes;

            if (!sugestoes || !sugestoes.sugestao) {
              resposta = 'Não há horários disponíveis para agendamento no momento.';
              break;
            }

            // Formatar mensagem com sugestão principal e até 3 alternativas
            const dataSug = sugestoes.sugestao.data;
            const periodoSug = sugestoes.sugestao.periodo;

            // Armazenar a sugestão principal para uso na confirmação
            user.sugestaoData = dataSug;
            user.sugestaoPeriodo = periodoSug;
            user.tipoUltimaPergunta = 'AGENDAMENTO_SUGESTAO'; // Indica que uma sugestão foi feita
            console.log(`[DEBUG] Sugestão principal armazenada para confirmação: Data=${user.sugestaoData}, Período=${user.sugestaoPeriodo}`);

            const dataFormatada = dayjs(dataSug).format('DD/MM/YYYY');
            const diaSemana = diaDaSemanaExtenso(dataSug);
            const periodoExtenso = periodoSug === 'M' ? 'manhã' : 'tarde';
            const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;

            // Alternativas
            let alternativas = '';
            if (sugestoes.alternativas && sugestoes.alternativas.length > 0) {
              // Agrupa alternativas por data/periodo, evita duplicidade
              const alternativasUnicas = [];
              const seen = new Set([`${sugestoes.sugestao.data},${sugestoes.sugestao.periodo}`]); // Inicializa o Set com a sugestão principal para evitar duplicação
              
              for (const alt of sugestoes.alternativas) {
                if (!alternativasUnicas.some(a => a.data === alt.data && a.periodo === alt.periodo)) {
                  alternativasUnicas.push(alt);
                }
                if (alternativasUnicas.length >= 3) break;
              }
              
              alternativas = alternativasUnicas.map(alt => {
                const dataAlt = dayjs(alt.data).format('DD/MM/YYYY');
                const diaAlt = diaDaSemanaExtenso(alt.data);
                const periodoAlt = alt.periodo === 'M' ? 'manhã' : 'tarde';
                return `• ${diaAlt}, ${dataAlt} pela ${periodoAlt}`;
              }).join('\n');
            }

            resposta = `${diaSemana}, ${dataFormatada} pela ${periodoExtenso} está disponível para agendamento da OS ${user.osEscolhida.id} (${assunto}). ` +
              `Está bom para você ou prefere outra opção? Se preferir, posso verificar outras datas disponíveis.`;
            break;
          }

          // Fluxo antigo se não houver OS escolhida (deve ser raro)
          if (!user.osEscolhida || !user.dataInterpretada || !user.periodoAgendamento) {
            resposta = await gerarMensagemDaIntent({
              intent,
              agentId: 'default-agent',
              dados: contexto,
              promptExtra: 'Faltam OS, data ou período para agendar.'
            });
            break;
          }

          user.aguardandoConfirmacaoDeAgendamento = true;
          resposta = `Confirma agendar a OS ${user.osEscolhida.id} para ${dayjs(user.dataInterpretada).format('DD/MM/YYYY')} no período da ${user.periodoAgendamento === 'M' ? 'manhã' : 'tarde'}?`;
          break;
        }
        case 'agendar_outra_data': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
            if (resposta) break;
             if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de reagendar.';
                 break;
            }
          }
          // The call to verificarOSEscolhida is now redundant.

          if (!!user.dataInterpretada || !!user.periodoAgendamento) {
            user.periodoAgendamento = null; // Limpa o período anterior
            user.dataInterpretada = null; // Limpa a data anterior
          }
          
          // This case implies the user wants to provide a new date/time.
          resposta = await gerarMensagemDaIntent({
            intent: 'extrair_data', // Transition to a state that expects date input
            agentId: 'default-agent',
            dados: contexto,
            promptExtra: `Entendido. Para qual nova data e período (manhã ou tarde) você gostaria de reagendar a OS ${user.osEscolhida.id}?`
          });
          user.etapaAtual = 'extrair_data'; // Set the conversation to expect a date next.
          break;
        }
        case 'consultar_disponibilidade_data': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
             if (resposta) break;
             if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de consultar a disponibilidade.';
                 break;
            }
          }
          // The call to verificarOSEscolhida is now redundant.
          
          const dataInterp = await interpretarDataNatural(mensagem, 'default-agent', contexto, 'Frase do usuário: "' + mensagem + '"');
          console.log('====== DATA SOLICITADA PARA VERIFICAÇÃO: ======');
          console.log(dataInterp);
          console.log('===============================');
          
          // Se não encontrou data válida, informa ao usuário
          if (!dataInterp || !dayjs(dataInterp).isValid()) {
            resposta = "Desculpe, não consegui entender a data solicitada. Pode me dizer novamente de outra forma, por exemplo: 'dia 25/12' ou 'próxima segunda-feira'?";
            break;
          }
          
          // Interpretar o período da mensagem (manhã ou tarde)
          const periodoInterp = await interpretaPeriodo(mensagem);
          const periodoSolicitado = periodoInterp || null; // Se não especificou, consideramos qualquer período
          
          // Obter as sugestões de agendamento para a OS escolhida
          const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);
          user.sugestoesAgendamento = sugestoes;
          
          // Se não há sugestões disponíveis
          if (!sugestoes || !sugestoes.alternativas || sugestoes.alternativas.length === 0) {
            resposta = "Desculpe, não foi possível verificar a disponibilidade para esta data. Vamos tentar outra abordagem?";
            break;
          }
          
          // Verificar se a data solicitada está entre as alternativas disponíveis
          const dataSolicitada = dayjs(dataInterp).format('YYYY-MM-DD');
          let datasDisponiveis = [];
          let disponibilidadeEncontrada = false;
          let alternativasNaData = [];
          
          // Verifica todas as alternativas para encontrar a data solicitada
          sugestoes.alternativas.forEach(alternativa => {
            // Adicionar todas as datas únicas disponíveis para apresentar ao usuário caso necessário
            if (!datasDisponiveis.includes(alternativa.data)) {
              datasDisponiveis.push(alternativa.data);
            }
            
            // Verifica se encontramos a data solicitada
            if (alternativa.data === dataSolicitada) {
              disponibilidadeEncontrada = true;
              alternativasNaData.push(alternativa);
            }
          });
          
          // Se a data solicitada não está disponível
          if (!disponibilidadeEncontrada) {
            // Formatar as datas disponíveis para apresentar ao usuário
            const datasFormatadas = datasDisponiveis.map(data => {
              const dataObj = dayjs(data);
              const diaSemana = diaDaSemanaExtenso(dataObj);
              return `${diaSemana}, ${dataObj.format('DD/MM/YYYY')}`;
            }).slice(0, 5); // Mostrar apenas as 5 primeiras opções
            
            resposta = `Desculpe, o dia ${dayjs(dataSolicitada).format('DD/MM/YYYY')} não está disponível para agendamento. ` +
              `Posso oferecer as seguintes datas:\n\n• ${datasFormatadas.join('\n• ')}\n\nQual dessas opções seria melhor para você?`;
            break;
          }
          
          // Verificar disponibilidade para o período solicitado
          const alternativasNoPeriodo = periodoSolicitado ? 
            alternativasNaData.filter(alt => alt.periodo === periodoSolicitado) : 
            alternativasNaData;
          
          // Se não há disponibilidade no período solicitado, mas há em outro
          if (periodoSolicitado && alternativasNoPeriodo.length === 0 && alternativasNaData.length > 0) {
            const outroPeriodo = periodoSolicitado === 'M' ? 'tarde' : 'manhã';
            resposta = `Encontrei disponibilidade para o dia ${dayjs(dataSolicitada).format('DD/MM/YYYY')}, mas apenas no período da ${outroPeriodo}. ` +
              `Esse horário seria bom para você?`;
            
            // Atualiza informações da sessão para facilitar confirmação
            user.dataInterpretada = dataSolicitada;
            user.periodoAgendamento = periodoSolicitado === 'M' ? 'T' : 'M';
          } 
          // Se há disponibilidade no período solicitado
          else if (alternativasNoPeriodo.length > 0) {
            const periodoExtenso = periodoSolicitado === 'M' ? 'manhã' : 'tarde';
            const dataObj = dayjs(dataSolicitada);
            const diaSemana = diaDaSemanaExtenso(dataObj);
            
            resposta = `Ótimo! Temos disponibilidade para ${diaSemana}, dia ${dataObj.format('DD/MM/YYYY')}, no período da ${periodoExtenso}. ` +
              `Posso confirmar esse agendamento para você?`;
            
            // Atualiza informações da sessão para facilitar confirmação
            user.dataInterpretada = dataSolicitada;
            user.periodoAgendamento = periodoSolicitado;
          }
          // Se encontrou a data, mas nenhum período foi especificado
          else {
            const periodosDisponiveis = alternativasNaData.map(alt => alt.periodo === 'M' ? 'manhã' : 'tarde');
            const dataObj = dayjs(dataSolicitada);
            const diaSemana = diaDaSemanaExtenso(dataObj);
            
            resposta = `Encontrei disponibilidade para ${diaSemana}, dia ${dataObj.format('DD/MM/YYYY')}, nos seguintes períodos: ` +
              `${periodosDisponiveis.join(' e ')}. Qual período você prefere?`;
          }
          break;
        }      
        case 'confirmar_agendamento': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
            if (resposta) break;
             if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de confirmar o agendamento.';
                 break;
            }
          }
            let msg = 'Ops! Parece que ainda não selecionamos uma OS. Pode me dizer qual é?';
            if (user.osList && user.osList.length > 0) {
              const abertas = user.osList.filter(os => os.status === 'A');
              const agendadas = user.osList.filter(os => os.status === 'AG');
              if (abertas.length > 0) {
                msg += '\n\nOS abertas:';
                abertas.forEach(os => {
                  msg += `\n• ${os.id} - ${os.titulo || os.mensagem || 'Sem descrição'}`;
                });
              }
              if (agendadas.length > 0) {
                msg += '\n\nOS agendadas:';
                agendadas.forEach(os => {
                  msg += `\n• ${os.id} - ${os.titulo || os.mensagem || 'Sem descrição'} (para ${os.data_agenda_final ? dayjs(os.data_agenda_final).format('DD/MM/YYYY [às] HH:mm') : 'data não informada'})`;
                });
              }
              msg += '\nSe quiser, é só me dizer o número da OS ou a posição na lista! 😊';
            }
            resposta = msg;
            break;
          }

          // 1. Definir data e período para esta tentativa de confirmação.
          let dataConfirmacao = null;
          let periodoConfirmacao = null;
          console.log('[DEBUG] confirmar_agendamento: Tentando extrair data/período da mensagem atual:', mensagem);

          // 2. Tentar extrair data e período da mensagem de confirmação do usuário.
          const interpretadoDaMensagem = await interpretaDataePeriodo({
            mensagem,
            agentId: 'default-agent',
            dados: contexto,
            promptExtra: 'Tente identificar data e/ou período para o agendamento na mensagem de confirmação.'
          });

          if (interpretadoDaMensagem) {
            if (interpretadoDaMensagem.data_interpretada && dayjs(interpretadoDaMensagem.data_interpretada).isValid()) {
              dataConfirmacao = interpretadoDaMensagem.data_interpretada;
              console.log('[DEBUG] confirmar_agendamento: Data extraída da mensagem de confirmação:', dataConfirmacao);
            }
            if (interpretadoDaMensagem.periodo_interpretado) {
              periodoConfirmacao = interpretadoDaMensagem.periodo_interpretado;
              console.log('[DEBUG] confirmar_agendamento: Período extraído da mensagem de confirmação:', periodoConfirmacao);
            }
          }

          // 3. Se data ou período ainda estiverem faltando E uma sugestão foi feita anteriormente (`AGENDAMENTO_SUGESTAO`), usar a sugestão.
          if ((!dataConfirmacao || !periodoConfirmacao) &&
              user.tipoUltimaPergunta === 'AGENDAMENTO_SUGESTAO' &&
              user.sugestaoData && user.sugestaoPeriodo) {
            console.log('[DEBUG] confirmar_agendamento: Usando sugestão anterior pois data/período não foram totalmente extraídos da mensagem atual ou são inválidos.');
            if (!dataConfirmacao && user.sugestaoData && dayjs(user.sugestaoData).isValid()) {
              dataConfirmacao = user.sugestaoData;
              console.log('[DEBUG] confirmar_agendamento: Usando user.sugestaoData:', dataConfirmacao);
            }
            if (!periodoConfirmacao && user.sugestaoPeriodo) {
              periodoConfirmacao = user.sugestaoPeriodo;
              console.log('[DEBUG] confirmar_agendamento: Usando user.sugestaoPeriodo:', periodoConfirmacao);
            }
          }

          // Atualizar o estado do usuário com a data e período definidos para esta confirmação.
          user.dataInterpretada = dataConfirmacao;
          user.periodoAgendamento = periodoConfirmacao;
          console.log(`[DEBUG] confirmar_agendamento: Data para confirmação final: ${user.dataInterpretada}, Período: ${user.periodoAgendamento}`);
          // Agora, decide o que pedir para o usuário
          if (!user.dataInterpretada && !user.periodoAgendamento) {
            resposta = 'Preciso que você me informe a data e o período para agendarmos.';
            break;
          }
          if (!user.dataInterpretada) {
            resposta = 'Qual data você prefere para o agendamento?';
            break;
          }
          if (!user.periodoAgendamento) {
            resposta = `Para o dia ${dayjs(user.dataInterpretada).format('DD/MM/YYYY')}, você prefere manhã ou tarde?`;
            break;
          }

          // Verificar se estamos esperando confirmação ou se o usuário já confirmou
          if (!user.aguardandoConfirmacao) {
            // Se não estamos aguardando confirmação, perguntar ao usuário para confirmar
            const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
            const diaSemana = diaDaSemanaExtenso(user.dataInterpretada);
            const periodoExtenso = user.periodoAgendamento === 'M' ? 'manhã' : 'tarde';
            const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
            
            resposta = `${diaSemana}, ${dataFormatada} pela ${periodoExtenso} está disponível para agendamento da OS ${user.osEscolhida.id} (${assunto}). Confirma o agendamento para essa data?`;
            
            user.aguardandoConfirmacao = true;
            break;
          }
          
          // Se passou aqui, temos tudo: OS + data + período e o usuário confirmou
          // Definir horário padrão com base no período (manhã = 09:00:00, tarde = 14:00:00)
          const horarioPadrao = user.periodoAgendamento === 'M' ? '09:00:00' : '14:00:00';
          const dataAgendamento = `${user.dataInterpretada} ${horarioPadrao}`; // Formato: YYYY-MM-DD HH:MM:SS
          
          // Criar o payload com os dados básicos - a função atualizarOS vai calcular as datas corretas
          const payload = {
           ...user.osEscolhida,
             data_agenda_final: dataAgendamento, // Formato correto: YYYY-MM-DD HH:MM:SS
            melhor_horario_agenda: user.periodoAgendamento // Usar o período escolhido (M ou T)
          };
          
          console.log(`Enviando agendamento: OS=${user.osEscolhida.id}, Data=${dataAgendamento}, Período=${user.periodoAgendamento}`);

          const resultado = await atualizarOS(user.osEscolhida.id, payload);
          console.log('resultado: ' + JSON.stringify(resultado));
          
          // Verificar se houve erro no agendamento
          if (resultado?.detalhes?.type === 'error') {
            // Tratar erros comuns de forma amigável
            if (resultado.detalhes.message.includes('Data de fim deve ser maior')) {
              resposta = `Ops! Tive um probleminha técnico ao agendar sua visita. Estou anotando isso e vou resolver. Por favor, tente novamente daqui a pouco ou entre em contato com nosso suporte.`;
              console.error('Erro de data_final:', resultado.detalhes.message);
            } else {
              // Mensagem genérica para outros erros
              resposta = `Desculpe, não consegui agendar sua visita neste momento. Erro: ${resultado.detalhes.message}. Por favor, tente novamente mais tarde.`;
            }
          } else if (resultado?.mensagem && resultado.mensagem.includes('Falha')) {
            // Tratar mensagens de falha de forma amigável
            resposta = `Ops! Tive um probleminha ao agendar sua visita. Por favor, tente novamente daqui a pouco ou entre em contato com nosso suporte.`;
            console.error('Falha no agendamento:', resultado.mensagem);
          } else if (user.osEscolhida && user.dataInterpretada && user.periodoAgendamento) {
            const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
            const dataFormatada = dayjs(user.dataInterpretada).format('DD/MM/YYYY');
            const diaSemana = diaDaSemanaExtenso(user.dataInterpretada);
            resposta = `Prontinho! Sua visita para ${assunto} está agendada! Ficou para ${diaSemana}, dia ${dataFormatada} no período da ${user.periodoAgendamento === 'M' ? 'manhã' : 'tarde'}. Estou finalizando nosso atendimento. Caso precise de mim, estou por aqui.`;
          } else {
            resposta = `✅ Agendado para ${dayjs(user.dataInterpretada).format('DD/MM/YYYY')} no período da ${user.periodoAgendamento === 'M' ? 'manhã' : 'tarde'}.`;
          }

          console.log('antes de agendar: LOG ESTADO ');
          /* ----------- LOG COMPLETO DO ESTADO ANTES DE RESPONDER --------- */
          logEstado({ numero, user, intent, resposta });
          // Limpa o contexto do usuário, mantendo apenas cpf, clienteId e numero
          Object.keys(user).forEach(key => {
            if (!['cpf', 'clienteId', 'numero', 'nomeCliente'].includes(key)) {
              delete user[key];
            }
          });

          // Recarregar a lista de OS após a limpeza do contexto
          if (user.clienteId) {
            console.log(`Recarregando lista de OS para o cliente ${user.clienteId} após agendamento`);
            try {
              // Recarregar a lista de OS do cliente de forma assíncrona
              buscarOSPorClienteId(user.clienteId)
                .then(osListAtualizada => {
                  if (osListAtualizada && osListAtualizada.length > 0) {
                    user.osList = osListAtualizada;
                    console.log(`Lista de OS recarregada com sucesso após agendamento: ${osListAtualizada.length} OS encontradas`);
                  }
                })
                .catch(error => {
                  console.error('Erro ao recarregar lista de OS após agendamento:', error);
                });
            } catch (error) {
              console.error('Erro ao iniciar recarga da lista de OS após agendamento:', error);
            }
          break;
        }
        case 'mais_detalhes': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
            if (resposta) break;
             if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe para qual Ordem de Serviço você gostaria de ver mais detalhes.';
                 break;
            }
          }
          if (user.osEscolhida) {
            // Se já tem OS escolhida, mostra os detalhes dela diretamente
            const os = user.osEscolhida;
            let dataFormatada = null;
            if (os.data_agenda_final && os.data_agenda_final !== '0000-00-00 00:00:00') {
              const dataObj = dayjs(os.data_agenda_final);
              const dia = dataObj.format('DD');
              const mes = dataObj.format('MMMM'); // Nome do mês por extenso
              const periodo = os.melhor_horario_agenda === 'M' ? 'manhã' : 'tarde';
              dataFormatada = `dia ${dia} do mês de ${mes} no período da ${periodo}`;
            }
            resposta = `Opa! Prontinho! Aqui estão os detalhes da sua OS ${os.id}:
          • Assunto: ${os.titulo || os.mensagem || 'Sem descrição'}
          • Status: ${os.status === 'AG' ? 'Agendada' : os.status === 'A' ? 'Aberta' : os.status}
          ${dataFormatada ? `• Data agendada: ${dataFormatada}\n` : ''}${os.endereco ? `• Endereço: ${os.endereco}\n` : ''}Se precisar de mais alguma coisa, é só me chamar! 😊`;
            
            Object.keys(user).forEach(key => {
              if (!['cpf', 'clienteId', 'numero', 'nomeCliente'].includes(key)) {
                delete user[key];
              }
            });
            Object.keys(user).forEach(key => {
              if (!['cpf', 'clienteId', 'numero', 'nomeCliente'].includes(key)) {
                delete user[key];
              }
            });
          } else {
             // This else implies user.osEscolhida was not set by ensureOSEscolhida.
             // ensureOSEscolhida should have set a response message in this case.
             if (!resposta) { // Should not happen if ensureOSEscolhida works as expected.
                resposta = 'Não consegui identificar a OS para mostrar os detalhes. Por favor, informe o número da OS.';
             }
          }
          break;
        }
        case 'confirmar_escolha_os': {
          if (!ensureClienteId(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } })) {
            break;
          }
          if (!await ensureOSEscolhida(user, { get resposta() { return resposta; }, set resposta(value) { resposta = value; } }, mensagem, contexto, intent, user.osList)) {
            if (resposta) break;
            if (!user.osEscolhida) { // Fallback
                 resposta = 'Por favor, me informe qual Ordem de Serviço você gostaria de confirmar.';
                 break;
            }
          }
          // The call to verificarOSEscolhida is now redundant.
          
          // Sugerir datas disponíveis para a OS escolhida, se possível
          const sugestoes = await gerarSugestoesDeAgendamento(user.osEscolhida);
          if (sugestoes && sugestoes.sugestao) {
            user.sugestaoData = sugestoes.sugestao.data;
            user.sugestaoPeriodo = sugestoes.sugestao.periodo;
            const dataFormatada = dayjs(sugestoes.sugestao.data).format('DD/MM/YYYY');
            const diaSemana = diaDaSemanaExtenso(sugestoes.sugestao.data);
            const periodoExtenso = sugestoes.sugestao.periodo === 'M' ? 'manhã' : 'tarde';
            const assunto = user.osEscolhida.titulo || user.osEscolhida.mensagem || `OS ${user.osEscolhida.id}`;
            
            resposta = `Perfeito! Vamos agendar a visita para a OS ${user.osEscolhida.id} (${assunto}).\nSe preferir, tenho uma sugestão: ${diaSemana}, dia ${dataFormatada}, no período da ${periodoExtenso}.\nSe quiser outra data ou período, é só me informar! Qual data e período você prefere?`;
          } else {
            resposta = `Perfeito! Vamos agendar a visita para a OS ${user.osEscolhida.id}. Por favor, informe a data e o período (manhã ou tarde) que você prefere, e faremos o possível para atender sua solicitação!`;
          }
          // Atualiza etapa para esperar data/período
          user.etapaAnterior = user.etapaAtual;
          user.etapaAtual = 'agendar_data';
          break;
        }
        case 'finalizado':
        default:
        {
          resposta = await gerarMensagemDaIntent({
            intent: 'finalizado',
            agentId: 'default-agent',
            dados: contexto,
            promptExtra: 'Encerrar atendimento.',
          });
          // Limpar todas as variáveis do usuário antes de resetar a sessão
          usuarios[numero] = {
            etapa: 'inicio',
            etapaAnterior: '',
            etapaAtual: 'inicio',
            mensagemAnteriorGPT: '',
            mensagemAnteriorCliente: '',
            cpf: null,
            clienteId: null,
            nomeCliente: null,
            osList: [],
            osEscolhida: null,
            dataInterpretada: null,
            periodoAgendamento: null,
            sugestaoData: null,
            sugestaoHora: null,
          };
          break;
        }
      } 
   
    if (!resposta) {
      // If, after all processing, 'resposta' is still empty, then provide a generic fallback.
      // This ensures that the bot always says something.
      if (user.clienteId && (!user.osList || user.osList.length === 0)) {
        // If user is identified but has no OS, this could be a common scenario for a generic reply.
        resposta = "Não encontrei Ordens de Serviço para você no momento. Gostaria de tentar outra opção?";
      } else if (user.clienteId && user.osList && user.osList.length > 0 && !user.osEscolhida) {
        // If user is identified, has OS list, but none is chosen, prompt to choose.
        resposta = "Tenho algumas Ordens de Serviço aqui. Para qual delas você gostaria de atendimento? Por favor, me informe o número da OS.";
      } else if (user.clienteId) {
        // Generic message if user is identified but context is unclear.
        resposta = "Como posso te ajudar hoje?";
      } else {
        // Default fallback if no context at all.
        resposta = 'Desculpe, não consegui entender. Pode tentar novamente? Se precisar de ajuda, digite "opções".';
      }
    }

    /* ----------- LOG COMPLETO DO ESTADO ANTES DE RESPONDER --------- */
    logEstado({ numero, user, intent, resposta });

    /* -------------------- 6. Persistência sessão ------------------- */
    user.etapaAnterior = user.etapaAtual || 'inicio'; // <- guarda o que era
    user.etapaAtual = intent;                      // <- atualiza para a nova intent
    user.mensagemAnteriorGPT = resposta;
    user.mensagemAnteriorCliente = mensagem;
    user.numero = numero; // Garante que o número sempre está presente
    usuarios[numero] = user;

    /* -------------------- 7. Envia WhatsApp ------------------------ */
    const twilioWhatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!twilioWhatsappNumber) {
      console.error('❌ ERRO FATAL: Variável de ambiente TWILIO_WHATSAPP_NUMBER não definida!');
      // Não podemos enviar resposta sem o número de origem
      return res.status(500).send('Erro de configuração do servidor: TWILIO_WHATSAPP_NUMBER não definido.');
    }

    if (!numero) {
      console.error('❌ ERRO: número do destinatário está undefined. Não é possível enviar mensagem.');
      return res.status(500).send('Erro interno: número do destinatário não encontrado na sessão.');
    }
    let messageData = {
      to: numero,
      from: twilioWhatsappNumber
    };

    if (responderComAudio) {
      try {
        console.log('[Webhook Unificado] Gerando áudio da resposta para:', resposta);
        const urlAudioResposta = await gerarAudioUrl(resposta);
        messageData.mediaUrl = [urlAudioResposta];
        console.log(`[Webhook Unificado] Áudio da resposta gerado: ${urlAudioResposta}`);
      } catch (err) {
        console.error('[Webhook Unificado] Erro ao gerar áudio da resposta, enviando como texto:', err.message);
        messageData.body = resposta; // Fallback para texto
      }
    } else {
      messageData.body = resposta;
    }

    await enviarMensagemWhatsApp(messageData);
    console.log(`✅ Mensagem enviada para ${numero}. Conteúdo: ${messageData.body || messageData.mediaUrl}`);

    // Prepara o payload de resposta detalhado para o HTTP response
    const responsePayload = {
      status: 'ok',
      recipient: numero,
      incomingMessage: mensagem, // Mensagem original ou transcrita do usuário
      detectedIntent: user.etapaAnterior, // Intent que acabou de ser processada
      previousClientMessage: user.mensagemAnteriorCliente || null, // Mensagem anterior do cliente
      previousBotMessage: user.mensagemAnteriorGPT || null, // Mensagem anterior do assistente
      response: {
        type: (responderComAudio && messageData.mediaUrl && messageData.mediaUrl.length > 0) ? 'audio' : 'text',
        content: (responderComAudio && messageData.mediaUrl && messageData.mediaUrl.length > 0) ? messageData.mediaUrl[0] : messageData.body,
        textEquivalent: resposta // Texto base da resposta, mesmo se áudio foi enviado
      },
      session: {
        currentStep: user.etapaAtual, // Próxima etapa da conversa
        cpf: user.cpf,
        clienteId: user.clienteId,
        osId: user.osEscolhida ? user.osEscolhida.id : null,
        dataAgendamento: user.dataInterpretada,
        periodoAgendamento: user.periodoAgendamento
      }
    };
    res.status(200).json(responsePayload); // Envia JSON detalhado

  } catch (error) {
    console.error('Erro no webhook:', error);
    // Tenta enviar uma mensagem de erro genérica se possível
    try {
      const twilioWhatsappNumberFallback = process.env.TWILIO_WHATSAPP_NUMBER;
      if (twilioWhatsappNumberFallback) {
        if (!numero) {
           console.error('❌ ERRO: número do destinatário está undefined. Não é possível enviar mensagem de erro.');
           return;
         }
         await enviarMensagemWhatsApp({
           to: numero,
          from: twilioWhatsappNumberFallback,
          body: 'Desculpe, ocorreu um erro interno ao processar sua solicitação. Tente novamente mais tarde.'
        });
      }
    } catch (sendError) {
      console.error('Erro ao enviar mensagem de erro para o usuário:', sendError);
    }
    res.status(500).send('Erro interno do servidor');
  }
});

module.exports = router;
