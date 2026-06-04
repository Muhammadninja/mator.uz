import { Controller, Post, Body } from '@nestjs/common';
import { AIService } from './ai.service';

interface DiagnoseRequestBody {
  problemDescription: string;
  carMake?: string;
  carModel?: string;
}

@Controller('api/ai')
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Post('diagnose')
  async diagnose(@Body() body: DiagnoseRequestBody) {
    return this.aiService.diagnose({
      problemDescription: body.problemDescription,
      carMake: body.carMake,
      carModel: body.carModel,
    });
  }
}
