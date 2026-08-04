"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import {
  ApiCustomField,
  ApiTaskTemplate,
  CUSTOM_FIELD_TYPES,
  CATEGORIES,
  Category,
  CustomFieldType,
} from "@/types";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { CustomFieldEditor } from "./CustomFieldEditor";
import { CustomFieldForm, FieldDraft } from "@/components/settings/CustomFieldForm";
import { sortedFields } from "@/lib/custom-fields";
import { SettingsCard, EmptyState, ListRow } from "@/components/settings/SettingsCard";
import { SectionProps } from "./types";

export function TaskFieldsSection({ projectId, project, patchProject }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState("#3b82f6");
  // "new" opens the create form; a field id opens the same form over that field
  const [fieldForm, setFieldForm] = useState<"new" | string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<ApiTaskTemplate | null>(null);

  function fail(err: unknown, fallback: string) {
    toast(err instanceof Error ? err.message : fallback, "error");
  }

  async function addCategory() {
    if (!newCategoryName.trim()) return;
    try {
      const categories = await api.post(`/api/projects/${projectId}/categories`, {
        name: newCategoryName.trim(),
        color: newCategoryColor,
      });
      patchProject({ categories });
      setNewCategoryName("");
      setNewCategoryColor("#3b82f6");
    } catch (err) {
      fail(err, "Failed to add category");
    }
  }

  async function removeCategory(name: string) {
    try {
      patchProject({ categories: await api.del(`/api/projects/${projectId}/categories`, { name }) });
    } catch (err) {
      fail(err, "Failed to remove category");
    }
  }

  // Throws rather than toasting: the form stays open on failure and shows the reason
  // beside the field, instead of closing and dropping what was typed
  async function addCustomField(draft: FieldDraft) {
    const customFields: ApiCustomField[] = await api.post(
      `/api/projects/${projectId}/custom-fields`,
      draft
    );
    patchProject({ customFields });
    setFieldForm(null);
  }

  async function saveCustomField(fieldId: string, patch: FieldDraft | Record<string, unknown>) {
    patchProject({
      customFields: await api.patch(
        `/api/projects/${projectId}/custom-fields/${fieldId}`,
        patch
      ),
    });
    setFieldForm(null);
  }

  async function removeCustomField(fieldId: string) {
    try {
      patchProject({
        customFields: await api.del(`/api/projects/${projectId}/custom-fields/${fieldId}`),
      });
    } catch (err) {
      fail(err, "Failed to remove custom field");
    }
  }

  async function addTemplate() {
    if (!newTemplateName.trim()) return;
    try {
      const taskTemplates: ApiTaskTemplate[] = await api.post(
        `/api/projects/${projectId}/templates`,
        { name: newTemplateName.trim() }
      );
      patchProject({ taskTemplates });
      setNewTemplateName("");
    } catch (err) {
      fail(err, "Failed to add template");
    }
  }

  async function removeTemplate(templateId: string) {
    try {
      patchProject({
        taskTemplates: await api.del(`/api/projects/${projectId}/templates`, { templateId }),
      });
    } catch (err) {
      fail(err, "Failed to remove template");
    }
  }

  async function saveTemplate(template: ApiTaskTemplate) {
    try {
      const taskTemplates: ApiTaskTemplate[] = await api.put(
        `/api/projects/${projectId}/templates`,
        { templateId: template._id, ...template }
      );
      patchProject({ taskTemplates });
      setEditingTemplate(null);
      toast("Template saved", "success");
    } catch (err) {
      fail(err, "Failed to save template");
    }
  }

  return (
    <>
      <SettingsCard
        title="Categories"
        description="The kind of work a task is. A category in use by tasks can't be removed."
      >
        <div className="flex flex-wrap gap-2">
          {(project.categories || []).map((cat) => (
            <span
              key={cat._id}
              className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm"
              style={{ backgroundColor: `${cat.color}33`, color: cat.color }}
            >
              {cat.name}
              <button
                onClick={() => removeCategory(cat.name)}
                aria-label={`Remove ${cat.name}`}
                className="ml-1 flex min-h-[24px] min-w-[24px] items-center justify-center hover:opacity-70"
              >
                &times;
              </button>
            </span>
          ))}
          {(project.categories || []).length === 0 && (
            <EmptyState>No categories yet. Add one to describe what kind of work a task is.</EmptyState>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="Category name..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCategory();
              }
            }}
          />
          <input
            type="color"
            value={newCategoryColor}
            onChange={(e) => setNewCategoryColor(e.target.value)}
            aria-label="Category colour"
            className="h-10 w-10 cursor-pointer rounded-lg border border-border bg-transparent"
          />
          <Button variant="secondary" onClick={addCategory}>
            Add
          </Button>
        </div>
      </SettingsCard>


      <SettingsCard
        title="Custom fields"
        description="Extra fields carried by every task in this project. Archived fields keep the values already on tasks and stop appearing in pickers."
      >
        <div className="space-y-2">
          {sortedFields(project.customFields || []).map((field) =>
            fieldForm === field._id ? (
              <CustomFieldForm
                key={field._id}
                field={field}
                onSubmit={(draft) => saveCustomField(field._id, draft)}
                onCancel={() => setFieldForm(null)}
              />
            ) : (
              <CustomFieldEditor
                key={field._id}
                field={field}
                onEdit={() => setFieldForm(field._id)}
                onSave={(patch) => saveCustomField(field._id, patch)}
                onDelete={() => removeCustomField(field._id)}
              />
            )
          )}
          {(project.customFields || []).length === 0 && fieldForm !== "new" && (
            <EmptyState>No custom fields yet. Add one to capture something the built-in fields don&apos;t.</EmptyState>
          )}
        </div>

        {fieldForm === "new" ? (
          <CustomFieldForm onSubmit={addCustomField} onCancel={() => setFieldForm(null)} />
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setFieldForm("new")}>
            + Add field
          </Button>
        )}
      </SettingsCard>

      <SettingsCard
        title="Task templates"
        description="Pre-filled starting points for tasks people create often."
      >
        <div className="space-y-2">
          {(project.taskTemplates || []).map((tpl) => (
            <div key={tpl._id} className="rounded-lg border border-border p-3">
              {editingTemplate?._id === tpl._id ? (
                <div className="space-y-3">
                  <Input
                    label="Name"
                    value={editingTemplate.name}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
                  />
                  <Input
                    label="Title template"
                    value={editingTemplate.title}
                    onChange={(e) => setEditingTemplate({ ...editingTemplate, title: e.target.value })}
                    placeholder="Pre-filled title"
                  />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-sm font-medium text-text-muted">Category</label>
                      <select
                        value={editingTemplate.category}
                        onChange={(e) =>
                          setEditingTemplate({
                            ...editingTemplate,
                            category: e.target.value as Category,
                          })
                        }
                        className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm"
                      >
                        {(project.categories?.map((x) => x.name) || CATEGORIES).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <Textarea
                    label="Description"
                    value={editingTemplate.description}
                    onChange={(e) =>
                      setEditingTemplate({ ...editingTemplate, description: e.target.value })
                    }
                    rows={3}
                  />
                  <Textarea
                    label="Acceptance Criteria"
                    value={editingTemplate.acceptanceCriteria}
                    onChange={(e) =>
                      setEditingTemplate({ ...editingTemplate, acceptanceCriteria: e.target.value })
                    }
                    rows={3}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => saveTemplate(editingTemplate)}>
                      Save
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditingTemplate(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{tpl.name}</span>
                    <span className="ml-2 text-xs text-text-muted">
                      {tpl.category}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setEditingTemplate({ ...tpl })}
                      className="px-2 py-1 text-xs text-text-muted hover:text-text"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => removeTemplate(tpl._id)}
                      className="px-2 py-1 text-xs text-text-muted hover:text-danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {(project.taskTemplates || []).length === 0 && (
            <EmptyState>Add a template to skip filling in the same fields every time.</EmptyState>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            placeholder="Template name..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTemplate();
              }
            }}
          />
          <Button variant="secondary" onClick={addTemplate}>
            Add
          </Button>
        </div>
      </SettingsCard>
    </>
  );
}
