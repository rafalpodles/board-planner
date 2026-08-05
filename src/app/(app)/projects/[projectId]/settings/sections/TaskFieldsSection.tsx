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
import { ListEditor } from "@/components/settings/ListEditor";
import { useDirtyGroup } from "@/components/settings/settings-context";
import { useDraft } from "@/hooks/use-draft";
import { Popover } from "@/components/ui/Popover";
import { SwatchPicker } from "@/components/ui/SwatchPicker";
import { categoryDiff, CategoryDraft } from "@/lib/category-diff";
import { nextColour } from "@/lib/palette";
import { SectionProps } from "./types";

export function TaskFieldsSection({ projectId, project, patchProject, stats }: SectionProps) {
  const api = useApi();
  const { toast } = useToast();

  // Explicit, because a row added here has no _id until it is saved
  const categories = useDraft<{ categories: CategoryDraft[] }>({
    categories: (project.categories || []).map((c) => ({
      _id: c._id,
      name: c.name,
      color: c.color,
    })),
  });
  // "new" opens the create form; a field id opens the same form over that field
  const [fieldForm, setFieldForm] = useState<"new" | string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<ApiTaskTemplate | null>(null);

  function fail(err: unknown, fallback: string) {
    toast(err instanceof Error ? err.message : fallback, "error");
  }

  useDirtyGroup(
    {
      id: "fields-categories",
      section: "fields",
      label: "Task fields · Categories",
      count: categories.count,
    },
    {
      save: async () => {
        const diff = categoryDiff(project.categories || [], categories.value.categories);
        try {
          let saved = project.categories || [];
          // Renames first: a name freed by a rename may be the one an added row wants,
          // and a removal checks the tasks still holding the old name
          for (const change of diff.changed) {
            saved = await api.patch(`/api/projects/${projectId}/categories`, change);
          }
          for (const added of diff.added) {
            saved = await api.post(`/api/projects/${projectId}/categories`, added);
          }
          for (const name of diff.removed) {
            saved = await api.del(`/api/projects/${projectId}/categories`, { name });
          }
          patchProject({ categories: saved });
          categories.commit({
            categories: saved.map((c) => ({ _id: c._id, name: c.name, color: c.color })),
          });
          toast("Categories saved", "success");
        } catch (err) {
          fail(err, "Failed to save categories");
        }
      },
      discard: categories.discard,
    }
  );

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
        <ListEditor
          items={categories.value.categories}
          onChange={(next) => categories.set("categories", next)}
          keyOf={(c, i) => c._id ?? `new-${i}`}
          nameOf={(c) => c.name || "this category"}
          reorderable={false}
          addLabel="Add category"
          canRemove={() => categories.value.categories.length > 1}
          onAdd={() =>
            categories.set("categories", [
              ...categories.value.categories,
              {
                name: "",
                color: nextColour(categories.value.categories.map((c) => c.color)),
              },
            ])
          }
          empty={
            <EmptyState>
              No categories yet. Add one to describe what kind of work a task is.
            </EmptyState>
          }
          renderRow={(cat, i) => (
            <>
              {/* Input renders a w-full wrapper, so it needs a sized box or it pushes
                  everything after it onto the next line */}
              <div className="w-[240px] shrink-0">
                <Input
                  value={cat.name}
                  aria-label="Category name"
                  placeholder="Category name..."
                  className="min-h-[38px] py-1.5"
                  onChange={(e) =>
                    categories.set(
                      "categories",
                      categories.value.categories.map((c, idx) =>
                        idx === i ? { ...c, name: e.target.value } : c
                      )
                    )
                  }
                />
              </div>
              <Popover
                width="w-auto"
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-label={`Colour for ${cat.name || "this category"}`}
                    className="focus-ring h-9 w-9 shrink-0 rounded-lg border border-border"
                    style={{ backgroundColor: cat.color }}
                  />
                )}
              >
                {({ close }) => (
                  <div className="p-2">
                    <SwatchPicker
                      value={cat.color}
                      label={`Colour for ${cat.name || "this category"}`}
                      onChange={(hex) => {
                        categories.set(
                          "categories",
                          categories.value.categories.map((c, idx) =>
                            idx === i ? { ...c, color: hex } : c
                          )
                        );
                        close();
                      }}
                    />
                  </div>
                )}
              </Popover>
            </>
          )}
        />
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
                usage={stats?.customFieldUsage[field._id] ?? (stats ? 0 : undefined)}
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
