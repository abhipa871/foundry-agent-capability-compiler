import { useEffect, useId, useRef, useState } from 'react';

type Schema = {
  type?: string | string[];
  title?: string;
  description?: string;
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  $ref?: string;
  $defs?: Record<string, Schema>;
};
export function schemaDefault(raw: unknown): unknown {
  const schema = raw as Schema;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [key, schemaDefault(value)]),
    );
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
  if (schema.type === 'array') return [];
  return '';
}

export function SchemaInput({
  schema: raw,
  value,
  onChange,
  disabled = false,
  prefix = '',
}: {
  schema: unknown;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  prefix?: string;
}) {
  const id = useId();
  const schema = raw as Schema;
  if (schema.type !== 'object' || !schema.properties)
    return (
      <JsonField label="Task input (JSON)" value={value} onChange={onChange} disabled={disabled} />
    );
  const object =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return (
    <div className="task-input-fields">
      {Object.entries(schema.properties).map(([key, property]) => {
        const name = prefix ? `${prefix}.${key}` : key;
        const fieldId = `${id}-${key}`;
        const update = (next: unknown) => onChange({ ...object, [key]: next });
        const required = schema.required?.includes(key) ?? false;
        if (property.type === 'object')
          return (
            <fieldset key={key}>
              <legend>{key}</legend>
              <SchemaInput
                schema={property}
                value={object[key]}
                onChange={update}
                disabled={disabled}
                prefix={name}
              />
            </fieldset>
          );
        if (property.type === 'boolean')
          return (
            <label key={key} className="task-checkbox" htmlFor={fieldId}>
              <input
                id={fieldId}
                type="checkbox"
                checked={object[key] === true}
                onChange={(event) => update(event.target.checked)}
                disabled={disabled}
              />
              {name}
            </label>
          );
        if (property.enum)
          return (
            <label key={key} className="task-field" htmlFor={fieldId}>
              {name}
              <select
                id={fieldId}
                required={required}
                disabled={disabled}
                value={JSON.stringify(object[key] ?? property.enum[0])}
                onChange={(event) => update(JSON.parse(event.target.value))}
              >
                {property.enum.map((item) => (
                  <option value={JSON.stringify(item)} key={JSON.stringify(item)}>
                    {String(item)}
                  </option>
                ))}
              </select>
            </label>
          );
        if (!['string', 'integer', 'number'].includes(String(property.type)))
          return (
            <JsonField
              key={key}
              label={`${name} (JSON)`}
              value={object[key] ?? schemaDefault(property)}
              onChange={update}
              disabled={disabled}
            />
          );
        const numeric = property.type === 'number' || property.type === 'integer';
        return (
          <label key={key} className="task-field" htmlFor={fieldId}>
            <span>
              {name}
              {required ? ' *' : ''}
            </span>
            <input
              id={fieldId}
              disabled={disabled}
              required={required}
              type={numeric ? 'number' : 'text'}
              step={property.type === 'integer' ? 1 : 'any'}
              min={property.minimum}
              max={property.maximum}
              minLength={property.minLength}
              maxLength={property.maxLength}
              pattern={property.pattern}
              placeholder={property.format === 'date-time' ? '2026-11-04T12:00:00.000Z' : undefined}
              value={object[key] === undefined ? '' : String(object[key])}
              onChange={(event) =>
                update(
                  numeric && event.target.value !== ''
                    ? Number(event.target.value)
                    : event.target.value,
                )
              }
            />
            <small>
              {property.description ??
                (property.format === 'date-time' ? 'ISO 8601 timestamp with timezone' : '')}
            </small>
          </label>
        );
      })}
    </div>
  );
}

function JsonField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setDraft(serialized);
    setError('');
    textarea.current?.setCustomValidity('');
  }, [serialized]);
  return (
    <label className="task-field">
      {label}
      <textarea
        ref={textarea}
        aria-label={label}
        disabled={disabled}
        value={draft}
        aria-invalid={!!error}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          try {
            const parsed: unknown = JSON.parse(next);
            setError('');
            event.target.setCustomValidity('');
            onChange(parsed);
          } catch {
            const message = 'Enter valid JSON, or use the full JSON editor.';
            setError(message);
            event.target.setCustomValidity(message);
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </label>
  );
}
