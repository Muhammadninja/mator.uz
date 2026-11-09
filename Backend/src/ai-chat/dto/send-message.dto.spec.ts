// The contract the mobile app relies on: ten turns of up to 2,000 characters each.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendMessageDto } from './send-message.dto';

const turns = (count: number, length: number) =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'я'.repeat(length),
  }));

const errorsFor = (body: object) =>
  validate(plainToInstance(SendMessageDto, body));

describe('SendMessageDto history (mobile contract)', () => {
  it('accepts the most the app sends: 10 turns x 2,000 characters', async () => {
    expect(await errorsFor({ message: 'hi', history: turns(10, 2000) })).toHaveLength(0);
  });

  it('still refuses an 11th turn', async () => {
    expect(await errorsFor({ message: 'hi', history: turns(11, 10) })).not.toHaveLength(0);
  });

  it('still refuses one turn over 2,000 characters', async () => {
    expect(await errorsFor({ message: 'hi', history: turns(1, 2001) })).not.toHaveLength(0);
  });

  it('still refuses an empty turn and an unknown role', async () => {
    expect(await errorsFor({ message: 'hi', history: [{ role: 'user', content: '' }] })).not.toHaveLength(0);
    expect(await errorsFor({ message: 'hi', history: [{ role: 'system', content: 'x' }] })).not.toHaveLength(0);
  });

  it('still refuses a whitespace message and one over 2,000 characters', async () => {
    expect(await errorsFor({ message: '   ' })).not.toHaveLength(0);
    expect(await errorsFor({ message: 'x'.repeat(2001) })).not.toHaveLength(0);
  });
});
