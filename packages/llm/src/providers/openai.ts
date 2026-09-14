import { createOpenAI } from "@easy-agent/openai";
import { generateText, streamText } from "ai";
import type { LLMProvider } from "../provider.js";
import {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
  Message,
} from "@easy-agent/schema/llm";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: ReturnType<typeof createOpenAI>;
  constructor(config:{apiKey:***;baseUrl?:string}){
    this.client =createOpenAI({
      apiKey:***,
      baseURL:config.baseUrl,
    });
  }
  async listModels():Promise<ModelInfo[]>{
    return [
      {
        id:"gpt-4o",
        name:"GPT-4o",
        provider:"openai",
        contextWindow:128000,
        maxOutputTokens:16348,
        supportsTools:true,
        supportsVision:true,
        inputConstPerMToken:2.5,
        outputConstPerMToken:10,
      },
      {
        id:"gpt-4o-mini",
        name:"GPT-4o",
        provider:"openai",
        contextWindow:128000,
        maxOutputTokens:16348,
        supportsTools:true,
        supportsVision:true,
        inputConstPerMToken:0.15,
        outputConstPerMToken:0.6,
      },
      {
        id:"gpt-4o-mini",
        name:"GPT-4o",
        provider:"openai",
        contextWindow:1047576,
        maxOutputTokens:23768,
        supportsTools:true,
        supportsVision:true,
        inputConstPerMToken:2,
        outputConstPerMToken:8,
      },
    ];
  }

  async generateText(request:LLMRequest):Promise<LLMResponse>{
    const model = this.client(request.model);
    const messages = this.convertMessages(request.system,request.message);
    const tools = request.tools?length?this.convertTools(request.tools):undefined;
    try{
      const result = await generateText({
        model,
        message,
        tools,
        temperature:request.generation?.remperature,
        maxTokens:request.generation?.maxTokens,
      });
      return{
        content:result.text,
        toolCalls:result.toolCalls?.map((tc)=>({
          id.tc.toolCallId,
          name:tc.toolName,
          input:tc.input,
        })),
        usage:{
          promptTokens:result.usage.promptTokens,
          
        }
      }
    }
  }
}
